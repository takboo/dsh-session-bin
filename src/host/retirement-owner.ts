import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import {
  lifecycleEqual, lifecycleKeySchema, retirementAuthorizationSchema, retirementCapabilitiesSchema,
  retirementManifestSchema, retirementParticipantSchema, retirementRequestSchema,
  retirementResourceReceiptSchema, retirementResourceSchema, retirementStateSchema,
} from '../operations/retirement.js';
import type {
  LifecycleKey, RetirementAuthorization, RetirementCapabilities, RetirementManifest, RetirementRequest, RetirementState,
} from '../operations/retirement.js';
import { retirementOwnerRecordSchema } from '../operations/retirement-owner.js';
import type { RetirementOwnerRecord } from '../operations/retirement-owner.js';
import type { SessionRetirementOwnerV1 } from './retirement.js';
import { retirementManifestDigest } from './retirement.js';
import { sameRetirementCapabilities } from './retirement-owner-store.js';
import type { RetirementOwnerStore } from './retirement-owner-store.js';

export type RetirementResource = z.infer<typeof retirementResourceSchema>;
export type RetirementResourceReceipt = z.infer<typeof retirementResourceReceiptSchema>;
export interface RetirementOwnerGuards {
  /** Synchronous checks apply to retained handles and late writes as well as new opens. */
  assertCanUse(lifecycle: LifecycleKey): void;
  assertCanCreate(sessionId: string): void;
}
export interface RetirementLifecycleScope {
  readonly lifecycle: LifecycleKey;
  current(): Promise<LifecycleKey | null>;
  activity(): Promise<string[]>;
  /** false acknowledges a known pending barrier; throws mean unknown outcome. */
  quiesce(request: RetirementRequest): Promise<boolean>;
  finalize(request: RetirementRequest): Promise<boolean>;
  release(): Promise<void>;
}
export interface RetirementLifecyclePort {
  inspect(sessionId: string): Promise<LifecycleKey | null>;
  /** Teardown disables these routes/retained references, rather than making them unguarded. */
  bindGuards(guards: RetirementOwnerGuards): Promise<() => Promise<void>>;
  /** A saved record grants maintenance access to exactly its retired lifecycle.
   * Recovery must work after transcript removal/finalization without create/resume.
   * Every acquire must restore current runtime exclusion/reservations for all
   * participants; persisted quiescence acknowledgements are not live leases. */
  acquire(expected: LifecycleKey, maintenance: RetirementOwnerRecord | null): Promise<RetirementLifecycleScope>;
}
export interface RetirementResourceParticipant {
  readonly identity: { id: string; version: string };
  bindGuards(guards: RetirementOwnerGuards): Promise<() => Promise<void>>;
  manifest(expected: LifecycleKey): Promise<RetirementResource[]>;
  fence(request: RetirementRequest): Promise<boolean>;
  quiesce(request: RetirementRequest): Promise<boolean>;
  /** Exact operation/resource/revision actions and all barriers are idempotent. */
  applyResource(request: RetirementRequest, resource: RetirementResource): Promise<RetirementResourceReceipt>;
  converge(request: RetirementRequest): Promise<boolean>;
}
export interface RetirementOwnerCheckpoint {
  request: RetirementRequest;
  manifest: RetirementManifest;
  record: RetirementOwnerRecord | null;
  resource: RetirementResource | null;
}
export interface RetirementOwnerCoordinatorOptions {
  capabilities: RetirementCapabilities;
  store: RetirementOwnerStore;
  lifecycle: RetirementLifecyclePort;
  participants: readonly RetirementResourceParticipant[];
  /** A bounded worker may pause only after a durable acknowledgement; the fence remains. */
  canAdvance?: (record: RetirementOwnerRecord) => boolean;
  checkpoint?: (name: string, context: RetirementOwnerCheckpoint) => Promise<void> | void;
}
export class RetirementOwnerError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetirementOwnerError';
  }
}
function requestEqual(a: RetirementRequest, b: RetirementRequest): boolean {
  return a.operationId === b.operationId && lifecycleEqual(a.expected, b.expected)
    && a.bin.entryId === b.bin.entryId && a.bin.entryVersion === b.bin.entryVersion && a.manifestDigest === b.manifestDigest;
}
function refused(phase: RetirementState['phase']): boolean { return phase === 'rejected' || phase === 'conflict'; }
function resourceOrder(a: RetirementResource, b: RetirementResource): number {
  const dispositions = ['release-reference', 'erase', 'retain-shared', 'retain-coordination'];
  const rank = dispositions.indexOf(a.disposition) - dispositions.indexOf(b.disposition);
  const first = JSON.stringify([a.ownerId, a.resourceId]);
  const second = JSON.stringify([b.ownerId, b.resourceId]);
  return rank || (first < second ? -1 : first > second ? 1 : 0);
}

/** Provider-neutral owner machinery. Ports must own the actual resources and
 * admission paths; this class supplies no native deletion or private-file adapter. */
export class RetirementOwnerCoordinator implements SessionRetirementOwnerV1 {
  private readonly descriptor: RetirementCapabilities;
  private readonly participants: readonly RetirementResourceParticipant[];
  private tail: Promise<unknown> = Promise.resolve();
  private failure: Error | undefined;
  private ready = false;
  private readonly frames = new AsyncLocalStorage<symbol>();
  private readonly activeFrames = new Set<symbol>();
  private readonly observations = new Set<Promise<unknown>>();
  private closing = false;
  private initializing: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly disposers: Array<() => Promise<void>> = [];
  private readonly expectedErrors = new WeakSet<Error>();
  readonly guards: RetirementOwnerGuards;

  constructor(private readonly options: RetirementOwnerCoordinatorOptions) {
    this.descriptor = retirementCapabilitiesSchema.parse(options.capabilities);
    this.participants = [...options.participants];
    this.verifyParticipants();
    this.validateJournal();
    this.guards = Object.freeze({
      assertCanUse: (input: LifecycleKey) => {
        this.requireReady();
        this.assertUnfenced(lifecycleKeySchema.parse(input));
      },
      assertCanCreate: (sessionId: string) => {
        this.requireReady();
        if (this.records().some(record => !refused(record.state.phase) && record.state.phase !== 'done'
          && record.state.request.expected.sessionId === sessionId)) {
          throw this.known('owner/session-fenced', 'An unfinished retirement fences this session identity.');
        }
      },
    });
  }
  initialize(): Promise<void> {
    if (this.closing) return Promise.reject(this.unavailable());
    return this.initializing ??= (async () => {
      try {
        await this.call('Owner journal capability binding', () => this.options.store.bindCapabilities(this.capabilitiesSnapshot()));
        this.validateJournal();
        const bind = async (work: () => Promise<() => Promise<void>>) => {
          const dispose = await this.call('Owner guard registration', work, false, false);
          if (typeof dispose !== 'function') throw new Error('Owner guard registration did not provide route teardown.');
          this.disposers.push(dispose);
          this.assertHealthy();
          if (this.closing) throw this.unavailable();
        };
        await bind(() => this.options.lifecycle.bindGuards(this.guards));
        for (const participant of this.participants) await bind(() => participant.bindGuards(this.guards));
        this.verifyParticipants();
        this.ready = true;
      } catch (error) {
        this.rememberFailure(error);
        this.ready = false;
        throw error;
      }
    })();
  }
  ownsCurrentMaintenanceFrame(): boolean {
    const frame = this.frames.getStore(); return frame !== undefined && this.activeFrames.has(frame);
  }
  isRefusal(error: unknown): boolean { return error instanceof Error && this.expectedErrors.has(error); }
  capabilities(): Promise<RetirementCapabilities> {
    this.requireControlReady();
    return Promise.resolve(this.capabilitiesSnapshot());
  }
  inspect(sessionId: string): Promise<LifecycleKey | null> {
    // Callback observations do not reenter the maintenance queue, but their
    // lifetime still belongs to close/drain and unknown-outcome handling.
    this.requireControlReady();
    const observation = (async () => {
      try {
        const input = await this.call('Owner lifecycle inspection', () => this.options.lifecycle.inspect(sessionId));
        this.requireControlReady();
        const value = input === null ? null : lifecycleKeySchema.parse(input);
        if (value && (value.sessionId !== sessionId || value.storeId !== this.descriptor.storeId)) throw new Error('Lifecycle observation belongs to another target/store.');
        return value;
      } catch (error) {
        if (!(error instanceof Error && this.expectedErrors.has(error))) this.rememberFailure(error);
        throw error;
      }
    })();
    this.observations.add(observation);
    void observation.finally(() => this.observations.delete(observation)).catch(() => {});
    return observation;
  }
  prepare(input: LifecycleKey): Promise<RetirementManifest> {
    const expected = lifecycleKeySchema.parse(input);
    return this.enqueue(async () => {
      this.assertMaintenanceUse(expected);
      return this.withScope(expected, null, async scope => {
        const current = await this.current(scope);
        if (!current || !lifecycleEqual(current, expected)) throw this.known('owner/lifecycle-changed', 'Lifecycle is not current.');
        this.assertMaintenanceUse(expected);
        return this.manifest(expected);
      });
    });
  }
  getOperation(operationId: string): Promise<RetirementState | null> {
    this.requireControlReady();
    const record = this.read(() => this.options.store.operation(operationId));
    return Promise.resolve(record ? retirementStateSchema.parse(record.state) : null);
  }
  getRecord(operationId: string): RetirementOwnerRecord | undefined {
    this.requireControlReady();
    const value = this.read(() => this.options.store.operation(operationId));
    return value ? retirementOwnerRecordSchema.parse(value) : undefined;
  }
  retire(input: RetirementRequest, authorize: () => Promise<RetirementAuthorization>, frozenInput?: RetirementManifest): Promise<RetirementState> {
    const request = retirementRequestSchema.parse(input);
    const frozen = frozenInput === undefined ? undefined : retirementManifestSchema.parse(frozenInput);
    return this.enqueue(async () => {
      const previous = this.read(() => this.options.store.operation(request.operationId));
      if (previous) {
        if (!requestEqual(previous.state.request, request)) throw this.known('owner/operation-id-reused', 'Operation identity already belongs to another request.');
        if (frozen) this.validateFrozen(request, frozen);
        return retirementStateSchema.parse(previous.state);
      }
      if (!frozen) throw this.known('owner/manifest-required', 'New retirement requires its full frozen confirmation manifest.');
      this.validateFrozen(request, frozen);
      this.assertMaintenanceUse(request.expected);
      return this.withScope(request.expected, null, async scope => {
        const current = await this.current(scope);
        if (!current || !lifecycleEqual(current, request.expected)) return this.refusal(request, frozen, 'conflict', 'lifecycle-changed');
        this.assertMaintenanceUse(request.expected);
        const fresh = await this.manifest(request.expected);
        if (retirementManifestDigest(fresh) !== request.manifestDigest) return this.refusal(request, frozen, 'conflict', 'resource-scope-changed');
        const activity = z.array(z.string().min(1).max(1024)).parse(await this.call('Owner activity inspection', () => scope.activity()));
        if (activity.length) return this.refusal(request, frozen, 'rejected', 'session-active');
        await this.checkpoint('before-authorize', this.context(request, frozen, null));
        const grant = retirementAuthorizationSchema.parse(await this.call('Host authorization callback', authorize));
        if (!grant.authorized) return this.refusal(request, frozen, 'rejected', grant.reason);
        const after = await this.current(scope);
        if (!after || !lifecycleEqual(after, request.expected)) return this.refusal(request, frozen, 'conflict', 'lifecycle-changed');
        if (retirementManifestDigest(await this.manifest(request.expected)) !== request.manifestDigest) return this.refusal(request, frozen, 'conflict', 'resource-scope-changed');
        const finalActivity = z.array(z.string().min(1).max(1024)).parse(await this.call('Owner final activity inspection', () => scope.activity()));
        if (finalActivity.length) return this.refusal(request, frozen, 'rejected', 'session-active');
        let record = this.emptyRecord({ schemaVersion: 1, request, manifest: frozen,
          authorizationId: grant.authorizationId, phase: 'fenced', reason: null, resources: [] });
        record = await this.save(record);
        await this.checkpoint('owner-fenced', this.contextFor(record));
        return this.advance(record, scope);
      });
    });
  }
  recover(operationId: string): Promise<RetirementState> {
    return this.enqueue(async () => {
      const record = this.read(() => this.options.store.operation(operationId));
      if (!record) throw this.known('owner/operation-not-found', 'Recovery requires a saved owner operation.');
      if (refused(record.state.phase) || record.state.phase === 'done') return retirementStateSchema.parse(record.state);
      return this.withScope(record.state.request.expected, record, scope => this.advance(record, scope));
    });
  }
  close(): Promise<void> {
    this.closing = true;
    return this.closePromise ??= (async () => {
      const errors: unknown[] = [];
      try { await this.initializing; } catch (error) { errors.push(error); }
      await this.tail;
      while (this.observations.size) await Promise.allSettled([...this.observations]);
      this.ready = false;
      for (const dispose of [...this.disposers].reverse()) try { await dispose(); } catch (error) { errors.push(error); }
      try { await this.options.store.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Retirement owner teardown failed.');
    })();
  }

  private async advance(input: RetirementOwnerRecord, scope: RetirementLifecycleScope): Promise<RetirementState> {
    let record = retirementOwnerRecordSchema.parse(input);
    const request = record.state.request;
    if (!this.canAdvance(record)) return retirementStateSchema.parse(record.state);
    if (record.state.phase === 'fenced') {
      for (const participant of this.participants) {
        const progress = record.participants.find(value => value.id === participant.identity.id)!;
        if (progress.fenced) continue;
        if (!await this.barrier('Participant fence', () => participant.fence(retirementRequestSchema.parse(request)))) {
          return this.pending(record, 'participant-fence-pending');
        }
        record = await this.save({ ...record, blockedReason: null,
          participants: record.participants.map(value => value.id === progress.id ? { ...value, fenced: true } : value) });
        await this.checkpoint('participant-fenced', this.contextFor(record));
        if (!this.canAdvance(record)) return retirementStateSchema.parse(record.state);
      }
      if (!record.lifecycleQuiesced) {
        if (!await this.barrier('Lifecycle quiescence', () => scope.quiesce(retirementRequestSchema.parse(request)))) return this.pending(record, 'lifecycle-quiescence-pending');
        record = await this.save({ ...record, blockedReason: null, lifecycleQuiesced: true });
        await this.checkpoint('lifecycle-quiesced', this.contextFor(record));
        if (!this.canAdvance(record)) return retirementStateSchema.parse(record.state);
      }
      for (const participant of this.participants) {
        const progress = record.participants.find(value => value.id === participant.identity.id)!;
        if (progress.quiesced) continue;
        if (!await this.barrier('Participant quiescence', () => participant.quiesce(retirementRequestSchema.parse(request)))) return this.pending(record, 'participant-quiescence-pending');
        record = await this.save({ ...record, blockedReason: null,
          participants: record.participants.map(value => value.id === progress.id ? { ...value, quiesced: true } : value) });
        await this.checkpoint('participant-quiesced', this.contextFor(record));
        if (!this.canAdvance(record)) return retirementStateSchema.parse(record.state);
      }
      record = await this.save({ ...record, state: { ...record.state, phase: 'quiesced' }, blockedReason: null });
      await this.checkpoint('owner-quiesced', this.contextFor(record));
      if (!this.canAdvance(record)) return retirementStateSchema.parse(record.state);
    }
    if (record.state.phase === 'quiesced') {
      // Draining can publish an already-admitted generation/write. Such a change
      // must not silently enlarge the confirmation, even under the durable fence.
      if (retirementManifestDigest(await this.manifest(request.expected)) !== request.manifestDigest) return this.pending(record, 'resource-scope-changed-after-quiescence');
      record = await this.save({ ...record, state: { ...record.state, phase: 'erasing' }, blockedReason: null });
      await this.checkpoint('owner-erasing', this.contextFor(record));
      if (!this.canAdvance(record)) return retirementStateSchema.parse(record.state);
    }
    if (record.state.phase === 'erasing') {
      for (const resource of [...record.state.manifest.resources].sort(resourceOrder)) {
        const previous = record.state.resources.find(value => value.ownerId === resource.ownerId && value.resourceId === resource.resourceId);
        if (previous && previous.status !== 'failed') continue;
        const participant = this.participants.find(value => value.identity.id === resource.ownerId)!;
        const receipt = retirementResourceReceiptSchema.parse(await this.call('Participant resource action', () =>
          participant.applyResource(retirementRequestSchema.parse(request), retirementResourceSchema.parse(resource))));
        if (receipt.ownerId !== resource.ownerId || receipt.resourceId !== resource.resourceId) throw new Error('Participant receipt changed its frozen resource identity.');
        await this.checkpoint('resource-effect', this.contextFor(record, resource));
        record = await this.save({ ...record, blockedReason: receipt.status === 'failed' ? receipt.reason : null,
          state: { ...record.state, resources: [...record.state.resources.filter(value => value.ownerId !== resource.ownerId || value.resourceId !== resource.resourceId), receipt] } });
        await this.checkpoint('resource-receipt', this.contextFor(record, resource));
        if (receipt.status === 'failed' || !this.canAdvance(record)) return retirementStateSchema.parse(record.state);
      }
      record = await this.save({ ...record, state: { ...record.state, phase: 'converging' }, blockedReason: null });
      await this.checkpoint('owner-converging', this.contextFor(record));
      if (!this.canAdvance(record)) return retirementStateSchema.parse(record.state);
    }
    if (record.state.phase === 'converging') {
      for (const participant of this.participants) {
        const progress = record.participants.find(value => value.id === participant.identity.id)!;
        if (progress.converged) continue;
        if (!await this.barrier('Participant convergence', () => participant.converge(retirementRequestSchema.parse(request)))) return this.pending(record, 'participant-convergence-pending');
        record = await this.save({ ...record, blockedReason: null,
          participants: record.participants.map(value => value.id === progress.id ? { ...value, converged: true } : value) });
        await this.checkpoint('participant-converged', this.contextFor(record));
        if (!this.canAdvance(record)) return retirementStateSchema.parse(record.state);
      }
      if (!record.lifecycleFinalized) {
        if (!await this.barrier('Lifecycle finalization', () => scope.finalize(retirementRequestSchema.parse(request)))) return this.pending(record, 'lifecycle-finalization-pending');
        await this.checkpoint('lifecycle-finalize-effect', this.contextFor(record));
        record = await this.save({ ...record, blockedReason: null, lifecycleFinalized: true });
        await this.checkpoint('lifecycle-finalized', this.contextFor(record));
        if (!this.canAdvance(record)) return retirementStateSchema.parse(record.state);
      }
      record = await this.save({ ...record, state: { ...record.state, phase: 'done' }, blockedReason: null });
      await this.checkpoint('owner-done', this.contextFor(record));
    }
    return retirementStateSchema.parse(record.state);
  }
  private emptyRecord(state: RetirementState): RetirementOwnerRecord {
    return retirementOwnerRecordSchema.parse({ schemaVersion: 1, state,
      participants: this.descriptor.participants.map(value => ({ ...value, fenced: false, quiesced: false, converged: false })),
      lifecycleQuiesced: false, lifecycleFinalized: false, blockedReason: null });
  }
  private async refusal(request: RetirementRequest, manifest: RetirementManifest, phase: 'rejected' | 'conflict', reason: string): Promise<RetirementState> {
    const record = await this.save(this.emptyRecord({ schemaVersion: 1, request, manifest, authorizationId: null, phase, reason, resources: [] }));
    return retirementStateSchema.parse(record.state);
  }
  private async pending(record: RetirementOwnerRecord, reason: string): Promise<RetirementState> {
    return retirementStateSchema.parse((await this.save({ ...record, blockedReason: reason })).state);
  }
  private async manifest(expected: LifecycleKey): Promise<RetirementManifest> {
    const resources: RetirementResource[] = [];
    for (const participant of this.participants) {
      const owned = z.array(retirementResourceSchema).max(4096).parse(await this.call('Participant resource inventory', () => participant.manifest(lifecycleKeySchema.parse(expected))));
      if (owned.some(value => value.ownerId !== participant.identity.id)) throw new Error('Participant inventory claimed another owner.');
      resources.push(...owned);
    }
    return retirementManifestSchema.parse({ schemaVersion: 1, lifecycle: expected, capabilities: this.capabilitiesSnapshot(), resources });
  }
  private validateFrozen(request: RetirementRequest, manifest: RetirementManifest): void {
    if (!lifecycleEqual(request.expected, manifest.lifecycle) || !sameRetirementCapabilities(this.descriptor, manifest.capabilities)
      || retirementManifestDigest(manifest) !== request.manifestDigest) throw this.known('owner/manifest-mismatch', 'Frozen confirmation does not match the request and owner composition.');
  }
  private async current(scope: RetirementLifecycleScope): Promise<LifecycleKey | null> {
    const value = await this.call('Scoped lifecycle observation', () => scope.current());
    return value === null ? null : lifecycleKeySchema.parse(value);
  }
  private async withScope<T>(expected: LifecycleKey, record: RetirementOwnerRecord | null, work: (scope: RetirementLifecycleScope) => Promise<T>): Promise<T> {
    let scope: RetirementLifecycleScope | undefined;
    let result!: T;
    const errors: unknown[] = [];
    try {
      scope = await this.call('Lifecycle maintenance scope', () => this.options.lifecycle.acquire(
        lifecycleKeySchema.parse(expected), record ? retirementOwnerRecordSchema.parse(record) : null), false, false);
      this.assertHealthy();
      if (!lifecycleEqual(lifecycleKeySchema.parse(scope.lifecycle), expected)) throw new Error('Maintenance scope belongs to a different lifecycle.');
      result = await work(scope);
    } catch (error) {
      if (!(error instanceof Error && this.expectedErrors.has(error))) this.rememberFailure(error);
      errors.push(error);
    }
    const acquired = scope;
    if (acquired) try { await this.call('Lifecycle scope release', () => acquired.release(), true); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Retirement scope and release failed.');
    return result;
  }
  private context(request: RetirementRequest, manifest: RetirementManifest, record: RetirementOwnerRecord | null, resource: RetirementResource | null = null): RetirementOwnerCheckpoint {
    return { request: retirementRequestSchema.parse(request), manifest: retirementManifestSchema.parse(manifest),
      record: record ? retirementOwnerRecordSchema.parse(record) : null, resource: resource ? retirementResourceSchema.parse(resource) : null };
  }
  private contextFor(record: RetirementOwnerRecord, resource: RetirementResource | null = null): RetirementOwnerCheckpoint {
    return this.context(record.state.request, record.state.manifest, record, resource);
  }
  private async checkpoint(name: string, context: RetirementOwnerCheckpoint): Promise<void> {
    if (this.options.checkpoint) await this.call('Owner checkpoint observer', async () => { await this.options.checkpoint!(name, context); });
  }
  private canAdvance(record: RetirementOwnerRecord): boolean {
    this.assertHealthy();
    try {
      const allowed = this.options.canAdvance ? z.boolean().parse(this.options.canAdvance(retirementOwnerRecordSchema.parse(record))) : true;
      this.assertHealthy();
      return allowed;
    } catch (cause) { throw this.rememberFailure(new Error('Owner work budget failed.', { cause })); }
  }
  private async barrier(name: string, work: () => Promise<boolean>): Promise<boolean> { return z.boolean().parse(await this.call(name, work)); }
  private async save(input: RetirementOwnerRecord): Promise<RetirementOwnerRecord> {
    const record = retirementOwnerRecordSchema.parse(input);
    this.validateFrozen(record.state.request, record.state.manifest);
    await this.call('Owner journal write', () => this.options.store.putOperation(retirementOwnerRecordSchema.parse(record)));
    return retirementOwnerRecordSchema.parse(record);
  }
  private records(): RetirementOwnerRecord[] {
    return this.read(() => this.options.store.operations()).map(value => retirementOwnerRecordSchema.parse(value));
  }
  private validateJournal(): void {
    for (const record of this.records()) {
      this.validateFrozen(record.state.request, record.state.manifest);
    }
  }
  private verifyParticipants(): void {
    const actual = this.participants.map(value => retirementParticipantSchema.parse(value.identity));
    if (actual.length !== this.descriptor.participants.length || new Set(actual.map(value => value.id)).size !== actual.length
      || actual.some(value => !this.descriptor.participants.some(expected => expected.id === value.id && expected.version === value.version))) {
      throw new Error('Owner participant set/version does not match the fixed composition.');
    }
  }
  private capabilitiesSnapshot(): RetirementCapabilities { return retirementCapabilitiesSchema.parse(this.descriptor); }
  private known(code: string, message: string): RetirementOwnerError {
    const error = new RetirementOwnerError(code, message);
    this.expectedErrors.add(error);
    return error;
  }
  private unavailable(): RetirementOwnerError {
    return new RetirementOwnerError('owner/unavailable', 'Retirement owner is not ready, closing or requires a fresh journal reopen.', this.failure ? { cause: this.failure } : undefined);
  }
  private assertMaintenanceUse(expected: LifecycleKey): void {
    this.requireControlReady();
    this.assertUnfenced(expected);
  }
  private assertUnfenced(expected: LifecycleKey): void {
    if (expected.storeId !== this.descriptor.storeId) throw this.known('owner/store-mismatch', 'Lifecycle belongs to another store.');
    if (this.records().some(record => !refused(record.state.phase)
      && (record.state.phase === 'done' ? lifecycleEqual(record.state.request.expected, expected)
        : record.state.request.expected.sessionId === expected.sessionId))) {
      throw this.known('owner/lifecycle-retired', 'Lifecycle is fenced or permanently retired.');
    }
  }
  private rememberFailure(cause: unknown): Error {
    const error = cause instanceof Error ? cause : new Error('Retirement owner received an unexpected rejection.', { cause });
    this.failure ??= error;
    return error;
  }
  private requireControlReady(): void {
    const frame = this.frames.getStore();
    if (!this.ready || this.failure) throw this.unavailable();
    if (this.closing && (frame === undefined || !this.activeFrames.has(frame))) {
      throw this.known('owner/closing', 'Retirement owner control routes are closing.');
    }
    this.assertHealthy();
  }
  private requireReady(): void {
    if (!this.ready || this.closing || this.failure) throw this.unavailable();
    this.assertHealthy();
  }
  private read<T>(work: () => T): T {
    try { return work(); }
    catch (cause) { throw this.rememberFailure(new Error('Owner journal observation failed.', { cause })); }
  }
  private assertHealthy(): void {
    if (this.failure) throw this.unavailable();
    try { this.verifyParticipants(); } catch (error) { throw this.rememberFailure(error); }
  }
  private async call<T>(name: string, work: () => Promise<T>, cleanup = false, postcheck = true): Promise<T> {
    if (!cleanup) this.assertHealthy();
    try {
      const value = await work();
      if (!cleanup && postcheck) this.assertHealthy();
      return value;
    } catch (cause) {
      throw this.rememberFailure(new Error(`${name} failed.`, { cause }));
    }
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    this.requireReady();
    const result = this.tail.then(() => {
      const frame = Symbol('retirement-maintenance');
      return this.frames.run(frame, async () => {
        if (this.failure) throw this.unavailable();
        this.assertHealthy();
        this.activeFrames.add(frame);
        try { return await work(); }
        catch (error) {
          if (!(error instanceof Error && this.expectedErrors.has(error))) throw this.rememberFailure(error);
          throw error;
        } finally { this.activeFrames.delete(frame); }
      });
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
