import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { SessionId } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
import { nativePlatformCandidate, nativePlatformVerified } from './platform-files.js';
import { nativeRetirementSdkFingerprint } from './native-retirement-sdk.js';
import { NativeJsonlFiles, NativeJsonlRefusal, nativeJsonlInventorySchema } from './native-jsonl-files.js';
import type { NativeJsonlInventory } from './native-jsonl-files.js';
import { NativeMetadataAdapter, NativeMetadataRefusal, nativeMetadataSnapshotSchema } from './native-retirement-metadata.js';
import type { NativeMetadataSnapshot } from './native-retirement-metadata.js';
import { NativeAdmission, NativeAdmissionError } from './native-retirement-admission.js';
import { NativePersistenceAdapter, nativeServiceInstance } from './native-retirement-persistence.js';
import { RetirementOwnerCoordinator, RetirementOwnerError } from './retirement-owner.js';
import type { RetirementLifecycleScope, RetirementResourceParticipant, RetirementOwnerCoordinatorOptions } from './retirement-owner.js';
import { DomainRetirementOwnerStore, retirementOwnerDomainSpec } from './retirement-owner-store.js';
import type { RetirementOwnerStore } from './retirement-owner-store.js';
import { lifecycleKeySchema, lifecycleEqual, retirementCapabilitiesSchema } from '../operations/retirement.js';
import type { LifecycleKey, RetirementCapabilities, RetirementManifest, RetirementRequest, RetirementAuthorization, RetirementState } from '../operations/retirement.js';
import { retirementOwnerRefusal, isRetirementOwnerRefusal } from './retirement.js';
import type { SessionRetirementOwnerV1 } from './retirement.js';
import type { RetirementOwnerRecord } from '../operations/retirement-owner.js';

const nativeOwnerRegistry = Symbol.for('dsh-session-bin.native-retirement-owner');
type GuardRegistration = { owner: NativeRetirementOwner; root: string; fingerprint: string; storeId: string };

const witnessSchema = z.object({ schemaVersion: z.literal(1), lifecycle: lifecycleKeySchema,
  inventory: nativeJsonlInventorySchema, metadata: nativeMetadataSnapshotSchema }).strict().superRefine((value, ctx) => {
  if (value.lifecycle.sessionId !== value.inventory.sessionId || value.lifecycle.sessionId !== value.metadata.sessionId) {
    ctx.addIssue({ code: 'custom', message: 'Native witness resources differ from its exact lifecycle.' });
  }
});
export const nativeRetirementDomainSpec = defineDomain({ name: 'session_bin_jsonl_resources', version: 1, layout: 'single',
  global: { schema: z.object({ schemaVersion: z.literal(1), storeId: z.uuid().nullable(), root: z.string().nullable(), fingerprint: z.string().nullable() }).strict(),
    initial: { schemaVersion: 1, storeId: null, root: null, fingerprint: null } },
  tables: { witnesses: domainTable(witnessSchema) } } as const);
export const nativeRetirementOwnerDomainSpec = defineDomain({ ...retirementOwnerDomainSpec, name: 'session_bin_jsonl_retirement_owner' } as const);
type Witness = z.infer<typeof witnessSchema>;
type Scope = { witness: Witness; inventory: NativeJsonlInventory; metadata: NativeMetadataSnapshot;
  blocked: string | null; lease: { release(): Promise<void> } | undefined; releaseAdmission: () => void };

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const metadataRevision = (value: NativeMetadataSnapshot) => hash({ sessionId: value.sessionId, global: value.global,
  workspaces: value.workspaces.map(item => ({ workspaceId: item.workspaceId, path: item.record.path })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
  cache: value.cache, queryProvider: value.queryProvider, queryPath: value.queryPath });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function known(error: unknown): string | null {
  if (error instanceof NativeJsonlRefusal || error instanceof NativeMetadataRefusal) return error.code;
  if (error instanceof NativeAdmissionError) return 'native/session-busy';
  return null;
}
export interface NativeRetirementOptions {
  /** Independent composition qualification, used by isolated candidate-platform fixtures.
   * The production Service never takes this callback from Host configuration. */
  platformQualification?: (runtime: { platform: NodeJS.Platform; arch: string; node: string }) => boolean;
  checkpoint?: RetirementOwnerCoordinatorOptions['checkpoint'];
  canAdvance?: RetirementOwnerCoordinatorOptions['canAdvance'];
}

/** Actual native log erasure, limited to the audited cold JSONL/Workspace composition. */
export class NativeRetirementOwner implements SessionRetirementOwnerV1 {
  private readonly scopes = new Map<string, Scope>();
  private readonly coordinator: RetirementOwnerCoordinator;
  private readonly descriptor: RetirementCapabilities;
  private readonly provider: NativePersistenceAdapter;
  private readonly originalProvider: object;
  private readonly restore: Array<() => Promise<void>> = [];
  private readonly observations = new Set<Promise<unknown>>();
  private fullyClosed = false;
  private observationsClosed = false;
  private closing: Promise<void> | undefined;

  private constructor(private readonly ctx: Context, private readonly files: NativeJsonlFiles,
    private readonly metadata: NativeMetadataAdapter, private readonly admission: NativeAdmission,
    private readonly domain: Domain<typeof nativeRetirementDomainSpec>, private readonly journal: RetirementOwnerStore,
    fingerprint: string, options: NativeRetirementOptions) {
    this.originalProvider = nativeServiceInstance(ctx.sessionPersistence);
    this.provider = new NativePersistenceAdapter(ctx.sessionPersistence, admission);
    this.descriptor = retirementCapabilitiesSchema.parse({ protocolVersion: 1, ownerId: 'session-bin-native-jsonl-owner',
      hostVersion: '0.2.0-rc.2', providerId: 'jsonl-session-records-v1', storeId: domain.global.get().storeId,
      participants: [{ id: 'native-jsonl-files', version: fingerprint }, { id: 'native-metadata', version: fingerprint }] });
    for (const record of journal.operations()) if (!['rejected', 'conflict'].includes(record.state.phase)) admission.markRetired(record.state.request.expected.sessionId);
    const guardedStore: RetirementOwnerStore = {
      bindCapabilities: value => this.io(() => journal.bindCapabilities(value)),
      operation: id => this.read(() => journal.operation(id)), operations: () => this.read(() => journal.operations()),
      putOperation: value => this.io(async () => {
        // Fail closed even if a medium commit succeeds but acknowledgement fails.
        if (!['rejected', 'conflict'].includes(value.state.phase)) admission.markRetired(value.state.request.expected.sessionId);
        await journal.putOperation(value);
      }), close: () => journal.close(),
    };
    const participants = [this.fileParticipant(fingerprint), this.metadataParticipant(fingerprint)];
    this.coordinator = new RetirementOwnerCoordinator({ capabilities: this.descriptor, store: guardedStore,
      lifecycle: { inspect: id => this.inspect(id), bindGuards: async () => async () => {},
        acquire: (expected, maintenance) => this.acquire(expected, maintenance) }, participants,
      ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}), ...(options.canAdvance ? { canAdvance: options.canAdvance } : {}) });
  }
  static async open(ctx: Context, options: NativeRetirementOptions = {}): Promise<NativeRetirementOwner | undefined> {
    // An implemented candidate is not production evidence. Never derive this
    // composition callback from permanentDeletion:true or client input.
    if (process.versions.node !== '24.18.1' || process.versions.uv !== '1.52.1' || !nativePlatformCandidate()) return;
    if (!nativePlatformVerified() && !options.platformQualification?.({
      platform: process.platform, arch: process.arch, node: process.versions.node,
    })) return;
    const fingerprint = await nativeRetirementSdkFingerprint();
    if (fingerprint === null) return;
    for (const name of ['sessionQuery', 'sessionProjectionCache', 'sessionController'] as const) {
      const pending = ctx.get(name, false);
      if (pending !== undefined && ctx.get(name) === undefined) {
        const instance = nativeServiceInstance(pending as object) as { ctx?: { fiber?: { await(): Promise<unknown> } } };
        if (!instance.ctx?.fiber) return;
        await instance.ctx.fiber.await();
        if (ctx.get(name) === undefined) return;
      }
    }
    const files = await NativeJsonlFiles.open(ctx.sessionPersistence);
    if (!files) return;
    const admission = new NativeAdmission();
    const providerInstance = nativeServiceInstance(ctx.sessionPersistence);
    const previous = Reflect.get(providerInstance, nativeOwnerRegistry) as GuardRegistration | undefined;
    if (previous && (!previous.owner.fullyClosed || previous.root !== files.root || previous.fingerprint !== fingerprint)) return;
    const metadata = await NativeMetadataAdapter.open(ctx, admission);
    if (!metadata) return;
    let domain: Domain<typeof nativeRetirementDomainSpec> | undefined;
    let journalDomain: Domain<typeof nativeRetirementOwnerDomainSpec> | undefined;
    let owner: NativeRetirementOwner | undefined;
    try {
      domain = await ctx.storageDomain.open(nativeRetirementDomainSpec);
      const global = domain.global.get();
      if (global.storeId === null) {
        await domain.global.set({ schemaVersion: 1, storeId: randomUUID(), root: files.root, fingerprint });
      } else if (global.root !== files.root || global.fingerprint !== fingerprint) {
        throw new Error('Native retirement resources belong to another root or audited composition.');
      }
      if (previous && previous.storeId !== domain.global.get().storeId) throw new Error('Native guard takeover belongs to another durable store.');
      journalDomain = await ctx.storageDomain.open(nativeRetirementOwnerDomainSpec);
      // Identical public record/global schemas; only this owner's domain name differs.
      const journal = new DomainRetirementOwnerStore(journalDomain as unknown as Domain<typeof retirementOwnerDomainSpec>);
      owner = new NativeRetirementOwner(ctx, files, metadata, admission, domain, journal, fingerprint, options);
      await owner.coordinator.initialize();
      admission.activate();
      if (previous) previous.owner.relinquishGuards();
      owner.restore.push(owner.provider.install());
      owner.restore.push(await metadata.install());
      Reflect.set(providerInstance, nativeOwnerRegistry, { owner, root: files.root, fingerprint, storeId: owner.descriptor.storeId } satisfies GuardRegistration);
      return owner;
    } catch (error) {
      admission.suspend();
      const errors = [error];
      for (const action of [() => owner?.close(), () => journalDomain?.close(), () => domain?.close()]) {
        try { await action(); } catch (cleanup) { errors.push(cleanup); }
      }
      if (errors.length > 1) throw new AggregateError(errors, 'Native retirement initialization/cleanup failed.');
      throw error;
    }
  }
  capabilities(): Promise<RetirementCapabilities> {
    if (this.admission.requiresRecovery()) return Promise.reject(new Error('Native retirement requires a complete reopen after unknown I/O.'));
    return this.coordinator.capabilities();
  }
  eligibility(id: string): Promise<string | null> { return this.observe(() => this.eligibilityInner(id)); }
  private async eligibilityInner(id: string): Promise<string | null> {
    if (nativeServiceInstance(this.ctx.sessionPersistence) !== this.originalProvider) return 'native/composition-changed';
    if (this.admission.isRetired(id)) return 'native/session-retired';
    if (this.provider.busy(id)) return 'native/persistence-retained';
    try {
      const scope = this.scopes.get(id);
      if (scope) {
        if (scope.blocked) return scope.blocked;
        await this.metadata.capture(id);
        return null;
      }
      const release = await this.admission.acquire(id);
      try {
        await this.metadata.capture(id);
        const snapshot = await this.provider.stat(id);
        if (!snapshot) return 'session-not-found';
        if (snapshot.header.origin === 'subagent') return 'native/subagent-unsupported';
        const inventory = await this.files.inspect(id, snapshot.header);
        const lease = await this.files.acquire(inventory);
        try { await this.files.current(inventory); } finally { await lease.release(); }
        return null;
      } finally { release(); }
    } catch (error) { const reason = known(error); if (reason !== null) return reason; this.admission.suspend(); throw error; }
  }
  inspect(id: string): Promise<LifecycleKey | null> { return this.observe(() => this.inspectInner(id)); }
  private async inspectInner(id: string): Promise<LifecycleKey | null> {
    if (this.admission.isRetired(id) && !this.scopes.has(id)) return null;
    const scope = this.scopes.get(id);
    if (scope) return scope.blocked ? null : lifecycleKeySchema.parse(scope.witness.lifecycle);
    const release = await this.admission.acquire(id);
    let lease: { release(): Promise<void> } | undefined;
    try {
      if (this.provider.busy(id)) throw retirementOwnerRefusal('native/persistence-retained');
      const snapshot = await this.provider.stat(id);
      if (!snapshot) return null;
      if (snapshot.header.origin === 'subagent') throw retirementOwnerRefusal('native/subagent-unsupported');
      const initial = await this.files.inspect(id, snapshot.header);
      lease = await this.files.acquire(initial);
      const inventory = await this.files.current(initial);
      const metadata = await this.metadata.capture(id);
      const previous = this.witness(id);
      const lifecycle = previous && equal(previous.inventory.anchor, inventory.anchor)
        ? previous.lifecycle : { storeId: this.descriptor.storeId, sessionId: id, lifecycleId: randomUUID() };
      await this.putWitness({ schemaVersion: 1, lifecycle, inventory, metadata });
      return lifecycleKeySchema.parse(lifecycle);
    } catch (error) {
      const reason = known(error); if (reason !== null) throw retirementOwnerRefusal(reason);
      throw error;
    } finally { try { await lease?.release(); } finally { release(); } }
  }
  async prepare(expected: LifecycleKey): Promise<RetirementManifest> {
    try { return await this.coordinator.prepare(expected); }
    catch (error) {
      if (this.coordinator.isRefusal(error)) throw retirementOwnerRefusal(error instanceof RetirementOwnerError ? error.code : 'native/lifecycle-changed');
      this.admission.suspend(); throw error;
    }
  }
  async retire(request: RetirementRequest, authorize: () => Promise<RetirementAuthorization>, manifest?: RetirementManifest): Promise<RetirementState> {
    try { return await this.coordinator.retire(request, authorize, manifest); }
    catch (error) {
      if (this.coordinator.isRefusal(error)) throw retirementOwnerRefusal(error instanceof RetirementOwnerError ? error.code : 'native/operation-refused');
      this.admission.suspend(); throw error;
    }
  }
  getOperation(id: string): Promise<RetirementState | null> { return this.coordinator.getOperation(id); }
  async recover(id: string): Promise<RetirementState> {
    try { return await this.coordinator.recover(id); }
    catch (error) {
      if (this.coordinator.isRefusal(error)) throw retirementOwnerRefusal(error instanceof RetirementOwnerError ? error.code : 'native/operation-refused');
      this.admission.suspend(); throw error;
    }
  }
  private async acquire(expected: LifecycleKey, maintenance: RetirementOwnerRecord | null): Promise<RetirementLifecycleScope> {
    const witness = this.witness(expected.sessionId);
    if (!witness || !lifecycleEqual(expected, witness.lifecycle)) throw new Error('Native lifecycle witness is missing or changed.');
    const releaseAdmission = await this.admission.acquire(expected.sessionId, maintenance !== null);
    const scope: Scope = { witness, inventory: witness.inventory, metadata: witness.metadata, blocked: null, lease: undefined, releaseAdmission };
    try {
      if (this.provider.busy(expected.sessionId)) scope.blocked = 'native/persistence-retained';
      if (!scope.blocked) {
        if (maintenance === null) {
          const snapshot = await this.provider.stat(expected.sessionId);
          if (!snapshot) scope.blocked = 'native/lifecycle-changed';
          else {
            const inventory = await this.files.inspect(expected.sessionId, snapshot.header);
            if (!equal(inventory.anchor, witness.inventory.anchor)) scope.blocked = 'native/lifecycle-changed';
            else scope.inventory = inventory;
          }
        }
        if (!scope.blocked) {
          scope.lease = await this.files.acquire(scope.inventory, { recovering: maintenance !== null });
          scope.inventory = await this.files.current(scope.inventory);
          if (maintenance === null) scope.metadata = await this.metadata.capture(expected.sessionId);
        }
      }
    } catch (error) {
      const reason = known(error);
      if (reason !== null && maintenance === null) scope.blocked = reason;
      else { this.admission.suspend(); try { await scope.lease?.release(); } finally { releaseAdmission(); } throw error; }
    }
    this.scopes.set(expected.sessionId, scope);
    return { lifecycle: expected, current: async () => scope.blocked ? null : expected,
      activity: async () => scope.blocked ? [scope.blocked] : (await this.ctx.waterfall('workspace/session-activity', { sessionId: SessionId(expected.sessionId) }, async () => [])).map(item => String(item.kind)),
      quiesce: async () => {
        await this.admission.drain(expected.sessionId);
        if (scope.blocked || this.provider.busy(expected.sessionId)) return false;
        await this.metadata.capture(expected.sessionId); return true;
      },
      finalize: async () => {
        if (this.provider.busy(expected.sessionId)) return false;
        this.provider.forget(expected.sessionId); return true;
      },
      release: async () => {
        this.scopes.delete(expected.sessionId);
        try { await scope.lease?.release(); } finally { releaseAdmission(); }
      } };
  }
  private observe<T>(work: () => Promise<T>): Promise<T> {
    if (this.admission.requiresRecovery()) return Promise.reject(new Error('Native retirement requires a complete reopen after unknown I/O.'));
    if (this.observationsClosed && !this.coordinator.ownsCurrentMaintenanceFrame()) return Promise.reject(retirementOwnerRefusal('native/closing'));
    const task = Promise.resolve().then(work).catch(error => {
      const reason = known(error);
      if (reason !== null) throw retirementOwnerRefusal(reason);
      // Only our trusted marker remains a business refusal; cleanup/FS errors
      // are unknown and fence the affected retirement candidates immediately.
      if (!isRetirementOwnerRefusal(error)) this.admission.suspend();
      throw error;
    });
    this.observations.add(task);
    void task.finally(() => this.observations.delete(task)).catch(() => {});
    return task;
  }
  private fileParticipant(version: string): RetirementResourceParticipant {
    return { identity: { id: 'native-jsonl-files', version }, bindGuards: async () => async () => {},
      manifest: async expected => {
        const scope = this.requireScope(expected);
        if (!scope.blocked) scope.inventory = await this.files.current(scope.inventory);
        return scope.inventory.files.map(row => ({ ownerId: 'native-jsonl-files', resourceId: row.resourceId, revision: row.revision,
          kind: 'transcript' as const, disposition: 'erase' as const, retention: null }));
      }, fence: async () => true, quiesce: async () => true,
      applyResource: async (request, resource) => {
        const scope = this.requireScope(request.expected);
        const row = scope.witness.inventory.files.find(item => item.resourceId === resource.resourceId && item.revision === resource.revision);
        if (!row || scope.blocked) throw new Error('Frozen native file witness is unavailable.');
        await this.files.erase(scope.witness.inventory, row);
        return { ownerId: resource.ownerId, resourceId: resource.resourceId, status: 'erased', reason: null };
      }, converge: async request => (await this.files.current(this.requireScope(request.expected).witness.inventory)).files.length === 0 };
  }
  private metadataParticipant(version: string): RetirementResourceParticipant {
    return { identity: { id: 'native-metadata', version }, bindGuards: async () => async () => {},
      manifest: async expected => {
        const scope = this.requireScope(expected);
        if (!scope.blocked) scope.metadata = await this.metadata.capture(expected.sessionId);
        // Commit the complete physical/metadata witness before the plan can be
        // admitted; recovery never resolves resources from a new same-ID object.
        if (!scope.blocked) {
          scope.witness = { ...scope.witness, inventory: scope.inventory, metadata: scope.metadata };
          await this.putWitness(scope.witness);
        }
        const kinds = ['workspace', ...(scope.metadata.cache.location !== null ? ['cache'] : []), ...(scope.metadata.queryProvider === 'sqlite-0.2.0-rc.2' ? ['index'] : [])] as const;
        return kinds.map(kind => ({ ownerId: 'native-metadata', resourceId: `native-${kind}`, revision: metadataRevision(scope.metadata),
          kind: kind as 'workspace' | 'cache' | 'index', disposition: 'erase' as const, retention: null }));
      }, fence: async () => true, quiesce: async () => true,
      applyResource: async (request, resource) => {
        const scope = this.requireScope(request.expected);
        if ((await this.files.current(scope.witness.inventory)).files.length !== 0) {
          return { ownerId: resource.ownerId, resourceId: resource.resourceId, status: 'failed', reason: 'native/files-remain' };
        }
        if (!await this.metadata.converge(scope.witness.metadata, request.expected, request)) {
          return { ownerId: resource.ownerId, resourceId: resource.resourceId, status: 'failed', reason: 'native/metadata-pending' };
        }
        return { ownerId: resource.ownerId, resourceId: resource.resourceId, status: 'erased', reason: null };
      }, converge: async request => {
        const scope = this.requireScope(request.expected);
        return this.metadata.converge(scope.witness.metadata, request.expected, request);
      } };
  }
  private requireScope(expected: LifecycleKey): Scope {
    const scope = this.scopes.get(expected.sessionId);
    if (!scope || !lifecycleEqual(scope.witness.lifecycle, expected)) throw new Error('Native resource action requires its exact held scope.');
    return scope;
  }
  private witness(id: string): Witness | undefined {
    return this.read(() => { const value = this.domain.table('witnesses').get(id); return value === undefined ? undefined : witnessSchema.parse(value); });
  }
  private putWitness(value: Witness): Promise<void> {
    const snapshot = witnessSchema.parse(value);
    return this.io(() => this.domain.table('witnesses').put(snapshot.lifecycle.sessionId, snapshot));
  }
  private read<T>(work: () => T): T { try { return work(); } catch (error) { this.admission.suspend(); throw error; } }
  private async io<T>(work: () => Promise<T>): Promise<T> { try { return await work(); } catch (error) { this.admission.suspend(); throw error; } }
  private relinquishGuards(): void {
    if (!this.fullyClosed) throw new Error('An active native retirement owner cannot surrender its guards.');
    this.metadata.forceRestore(); this.provider.forceRestore();
  }
  close(): Promise<void> {
    this.observationsClosed = true;
    return this.closing ??= (async () => {
      const errors: unknown[] = [];
      try { await this.coordinator.close(); } catch (error) { errors.push(error); }
      while (this.observations.size) await Promise.allSettled([...this.observations]);
      this.admission.beginClose();
      try { await this.admission.drain(); } catch (error) { errors.push(error); }
      for (const restore of this.restore.reverse()) try { await restore(); } catch (error) { errors.push(error); }
      try { await this.domain.close(); } catch (error) { errors.push(error); }
      this.fullyClosed = errors.length === 0;
      if (errors.length) throw new AggregateError(errors, 'Native retirement shutdown failed.');
    })();
  }
}
