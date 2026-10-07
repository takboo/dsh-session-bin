import { createHash, randomUUID } from 'node:crypto';
import { entrySchema } from '../operations/schema.js';
import type { BinEntry } from '../operations/schema.js';
import {
  lifecycleEqual, lifecycleKeySchema, preparePurgeRequestSchema, purgePlanSchema, purgeResultSchema,
  retirementBindingSchema, retirementCapabilitiesSchema, retirementManifestSchema, retirementStateSchema,
  retirementAuthorizationSchema, retirementRequestSchema,
} from '../operations/retirement.js';
import type {
  LifecycleKey, PreparePurgeRequest, PurgeOperation, PurgePlan, PurgeResult, RetirementBinding,
  RetirementCapabilities, RetirementManifest, RetirementRequest, RetirementState, RetirementAuthorization,
} from '../operations/retirement.js';
import type { RetirementStore } from './retirement-store.js';
import { sessionBinRefusal } from './module.js';

/** The resource owner implements its own durable admission fence and recovery.
 * This interface is a plugin seam, not a native DSH SDK service. */
export interface SessionRetirementOwnerV1 {
  capabilities(): Promise<RetirementCapabilities>;
  inspect(sessionId: string): Promise<LifecycleKey | null>;
  prepare(expected: LifecycleKey): Promise<RetirementManifest>;
  retire(request: RetirementRequest, authorize: () => Promise<RetirementAuthorization>, frozenManifest?: RetirementManifest): Promise<RetirementState>;
  getOperation(operationId: string): Promise<RetirementState | null>;
  recover(operationId: string): Promise<RetirementState>;
}
export interface RetirementOptions {
  store: RetirementStore;
  owner?: SessionRetirementOwnerV1;
  /** Admission is supplied by the Host composition, never by owner self-report or Client Config. */
  verified?: (capabilities: RetirementCapabilities) => boolean;
}
export interface PurgeHooks {
  newRequestsDisabled?: boolean;
  entry(sessionId: string): BinEntry | undefined;
  invalidated(entryId: string): boolean;
  archived(sessionId: string): Promise<boolean>;
  activity(sessionId: string): Promise<string[]>;
  deleteEntry(sessionId: string): Promise<void>;
  hasArchiveOperation(operationId: string): boolean;
  hasPendingArchiveOperation(sessionId: string): boolean;
}
export interface PurgeReconcileReport { completed: PurgeResult[]; pending: string[] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function capabilitiesKey(value: RetirementCapabilities): string {
  return canonical({ ...value, participants: [...value.participants].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
}
export function retirementManifestDigest(input: RetirementManifest): string {
  const manifest = retirementManifestSchema.parse(input);
  const ordered = { ...manifest, capabilities: JSON.parse(capabilitiesKey(manifest.capabilities)),
    resources: [...manifest.resources].sort((a, b) => {
      const first = JSON.stringify([a.ownerId, a.resourceId]);
      const second = JSON.stringify([b.ownerId, b.resourceId]);
      return first < second ? -1 : first > second ? 1 : 0;
    }) };
  return createHash('sha256').update(canonical(ordered)).digest('hex');
}
function sameBinding(a: RetirementBinding, b: RetirementBinding): boolean {
  return a.entryId === b.entryId && a.entryVersion === b.entryVersion && lifecycleEqual(a.lifecycle, b.lifecycle)
    && capabilitiesKey(a.capabilities) === capabilitiesKey(b.capabilities);
}
function samePlan(a: PurgePlan, b: PurgePlan): boolean {
  return a.sessionId === b.sessionId && a.expectedEntryId === b.expectedEntryId
    && (a.binding === null ? b.binding === null : b.binding !== null && sameBinding(a.binding, b.binding))
    && (a.manifest === null ? b.manifest === null : b.manifest !== null && retirementManifestDigest(a.manifest) === retirementManifestDigest(b.manifest));
}
function requestFor(plan: PurgePlan): RetirementRequest {
  if (!plan.binding || !plan.manifest) throw new Error('Executable purge lacks its lifecycle witness.');
  return retirementRequestSchema.parse({ operationId: plan.operationId, expected: plan.binding.lifecycle,
    bin: { entryId: plan.binding.entryId, entryVersion: plan.binding.entryVersion },
    manifestDigest: retirementManifestDigest(plan.manifest) });
}

function externalFailure(context: string, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${context}: ${message}`, { cause });
}
function externalRead<T>(context: string, work: () => T): T {
  try { return work(); } catch (cause) { throw externalFailure(context, cause); }
}
async function externalCall<T>(context: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (cause) { throw externalFailure(context, cause); }
}

/** Inner operations only: SessionBinModule owns the one queue, failure fence and lifetime lease. */
export class SessionBinPurgeModule {
  private readonly store: RetirementStore;
  constructor(private readonly options: RetirementOptions, private readonly hooks: PurgeHooks) {
    const store = options.store;
    this.store = {
      binding: id => externalRead('Retirement journal read failed', () => store.binding(id)),
      operation: id => externalRead('Retirement journal read failed', () => store.operation(id)),
      operations: () => externalRead('Retirement journal read failed', () => store.operations()),
      putBinding: value => externalCall('Retirement journal write failed', () => store.putBinding(value)),
      putOperation: value => externalCall('Retirement journal write failed', () => store.putOperation(value)),
      close: () => externalCall('Retirement journal close failed', () => store.close()),
    };
    for (const operation of this.store.operations()) {
      if (hooks.hasArchiveOperation(operation.plan.operationId)) throw new Error('An operation identity is claimed by both Bin journals.');
      if (operation.ownerState) this.validateOwnerState(operation.plan, operation.ownerState, operation.authorizationId);
    }
  }
  operation(operationId: string): PurgeOperation | undefined { return this.store.operation(operationId); }
  operations(): PurgeOperation[] { return this.store.operations(); }
  blocks(sessionId: string): boolean {
    return this.store.operations().some(item => item.plan.sessionId === sessionId && item.phase !== 'done');
  }
  ownsPendingEntry(entryId: string): boolean {
    return this.store.operations().some(item => item.entry?.entryId === entryId && item.phase !== 'done');
  }
  close(): Promise<void> { return this.store.close(); }

  async capture(entry: BinEntry): Promise<void> {
    const capabilities = await this.admittedCapabilities();
    if (!capabilities) return;
    const observed = await this.ownerCall(() => this.options.owner!.inspect(entry.sessionId));
    if (observed === null) return;
    const lifecycle = lifecycleKeySchema.parse(observed);
    if (lifecycle.sessionId !== entry.sessionId || lifecycle.storeId !== capabilities.storeId) {
      throw new Error('Resource owner inspection returned a different session/store.');
    }
    await this.store.putBinding({ schemaVersion: 1, entryId: entry.entryId, entryVersion: 1, lifecycle, capabilities });
  }
  async bindingMatches(entry: BinEntry): Promise<boolean> {
    const binding = this.store.binding(entry.entryId);
    if (!binding) return true; // Legacy/reversible entries carry no destructive authority.
    const capabilities = await this.admittedCapabilities();
    if (!capabilities || capabilitiesKey(capabilities) !== capabilitiesKey(binding.capabilities)) return false;
    const observed = await this.ownerCall(() => this.options.owner!.inspect(entry.sessionId));
    return observed !== null && lifecycleEqual(binding.lifecycle, lifecycleKeySchema.parse(observed));
  }

  async prepare(input: PreparePurgeRequest): Promise<PurgePlan> {
    const request = preparePurgeRequestSchema.parse(input);
    const entry = this.hooks.entry(request.sessionId);
    const binding = entry ? this.store.binding(entry.entryId) ?? null : null;
    const plan: PurgePlan = { schemaVersion: 1, action: 'purge', operationId: request.operationId ?? randomUUID(),
      sessionId: request.sessionId, expectedEntryId: entry?.entryId ?? null, binding, manifest: null, blockers: [] };
    const reason = await this.check(plan, false);
    if (reason) plan.blockers.push({ code: reason });
    else {
      const manifest = retirementManifestSchema.parse(await this.ownerCall(() => this.options.owner!.prepare(lifecycleKeySchema.parse(binding!.lifecycle))));
      this.validateManifest(binding!, manifest);
      plan.manifest = manifest;
    }
    return purgePlanSchema.parse(plan);
  }

  async execute(input: PurgePlan): Promise<PurgeResult> {
    const plan = purgePlanSchema.parse(input);
    if (this.hooks.hasArchiveOperation(plan.operationId)) {
      throw sessionBinRefusal('bin/operation-id-reused', 'Operation identity belongs to an archive request.');
    }
    const previous = this.store.operation(plan.operationId);
    if (previous) {
      if (!samePlan(previous.plan, plan)) throw sessionBinRefusal('bin/operation-id-reused', 'Purge identity belongs to a different request.');
      if (previous.phase === 'done') return purgeResultSchema.parse(previous.result);
      return this.recover(previous);
    }
    const current = this.hooks.entry(plan.sessionId);
    const entry = current?.entryId === plan.expectedEntryId ? current : null;
    const operation: PurgeOperation = { schemaVersion: 1, plan, createdAt: new Date().toISOString(),
      phase: 'intent', entry, authorizationId: null, ownerState: null, result: null };
    if ((current?.entryId ?? null) !== plan.expectedEntryId) return this.finish(operation, 'conflict', 'entry-changed');
    const reason = await this.check(plan, true);
    if (reason) return this.finish(operation, 'rejected', reason);
    const fresh = retirementManifestSchema.parse(await this.ownerCall(() => this.options.owner!.prepare(lifecycleKeySchema.parse(plan.binding!.lifecycle))));
    this.validateManifest(plan.binding!, fresh);
    if (retirementManifestDigest(fresh) !== retirementManifestDigest(plan.manifest!)) {
      return this.finish(operation, 'conflict', 'resource-scope-changed');
    }
    // Query before saving intent: an owner record with no local journal must
    // not be overwritten or silently treated as a new authorization.
    const existingOwnerOperation = await this.ownerCall(() => this.options.owner!.getOperation(plan.operationId));
    if (existingOwnerOperation !== null) {
      retirementStateSchema.parse(existingOwnerOperation);
      return this.finish(operation, 'conflict', 'owner-operation-id-reused');
    }
    await this.store.putOperation(operation);
    let authorizationId: string | null = null;
    let callbackUsed = false;
    let revoked = false;
    let authorizing: Promise<RetirementAuthorization> | undefined;
    let callbackViolation: Error | undefined;
    const assertLive = () => {
      if (revoked) throw new Error('Retirement authorization capability has been revoked.');
    };
    const refusedCall = (error: Error): Promise<RetirementAuthorization> => {
      const refused = Promise.reject<RetirementAuthorization>(error);
      void refused.catch(() => {}); // Contain an owner that ignores its rejected capability.
      return refused;
    };
    const authorize = (): Promise<RetirementAuthorization> => {
      if (revoked) return refusedCall(new Error('Retirement authorization capability has been revoked.'));
      if (callbackUsed) {
        callbackViolation = new Error('Retirement authorization capability is single-use.');
        return refusedCall(callbackViolation);
      }
      callbackUsed = true;
      authorizing = (async (): Promise<RetirementAuthorization> => {
        const reason = await this.check(plan, true, true);
        assertLive();
        if (reason !== null) return { authorized: false, reason };
        const nonce = randomUUID();
        await this.store.putOperation({ ...operation, phase: 'authorizing', authorizationId: nonce });
        assertLive();
        const afterWrite = await this.check(plan, true, true);
        assertLive();
        if (afterWrite !== null) return { authorized: false, reason: afterWrite };
        // The nonce is never in the request. Only a completed successful callback
        // hands it to the owner; a mere persisted attempt cannot prove admission.
        authorizationId = nonce;
        return retirementAuthorizationSchema.parse({ authorized: true, authorizationId: nonce });
      })();
      void authorizing.catch(() => {});
      return authorizing;
    };
    let state: RetirementState | undefined;
    const failures: unknown[] = [];
    try {
      state = await this.ownerCall(() => this.options.owner!.retire(requestFor(plan), authorize,
        retirementManifestSchema.parse(plan.manifest)));
    } catch (error) { failures.push(error); }
    finally {
      revoked = true;
      // An owner that started but did not await authorization cannot leave
      // writes running after this request, a terminal receipt, or lease release.
      if (authorizing) try { await authorizing; } catch (error) { failures.push(error); }
    }
    if (callbackViolation) failures.push(callbackViolation);
    if (failures.length) throw new AggregateError(failures, 'Retirement admission/authorization failed.');
    if (!state) throw new Error('Resource owner returned no retirement state.');
    const validated = this.validateOwnerState(plan, state, authorizationId);
    return this.acceptState(this.store.operation(plan.operationId)!, validated);
  }

  async reconcile(resume = false): Promise<PurgeReconcileReport> {
    const report: PurgeReconcileReport = { completed: [], pending: [] };
    for (const operation of this.store.operations()) {
      if (operation.phase === 'done') continue;
      const result = await this.recover(operation, resume);
      if (['success', 'rejected', 'conflict'].includes(result.status)) report.completed.push(result);
      else report.pending.push(operation.plan.operationId);
    }
    return report;
  }
  private ownerCall<T>(work: () => Promise<T>): Promise<T> {
    return externalCall('Retirement resource owner failed', work);
  }
  private async admittedCapabilities(): Promise<RetirementCapabilities | null> {
    if (!this.options.owner) return null;
    const capabilities = retirementCapabilitiesSchema.parse(await this.ownerCall(() => this.options.owner!.capabilities()));
    return this.options.verified?.(retirementCapabilitiesSchema.parse(capabilities)) === true ? capabilities : null;
  }
  private async check(plan: PurgePlan, requireManifest: boolean, authorizing = false): Promise<string | null> {
    if (this.hooks.newRequestsDisabled) {
      if (this.store.operations().some(item => item.phase !== 'done' && item.plan.sessionId === plan.sessionId
        && item.plan.operationId !== plan.operationId)) return 'pending-deletion';
      return await this.hooks.archived(plan.sessionId) ? 'permanent-deletion-unsupported' : 'not-archived';
    }
    const entry = this.hooks.entry(plan.sessionId);
    if (!entry) return 'not-in-bin';
    if (entry.entryId !== plan.expectedEntryId) return 'entry-changed';
    if (this.hooks.invalidated(entry.entryId) || !(await this.hooks.archived(plan.sessionId))) return 'archive-changed';
    if (this.hooks.hasPendingArchiveOperation(plan.sessionId)) return 'pending-operation';
    if (!authorizing && this.store.operations().some(item => item.phase !== 'done'
      && item.plan.sessionId === plan.sessionId && item.plan.operationId !== plan.operationId)) return 'pending-deletion';
    const capabilities = await this.admittedCapabilities();
    if (!capabilities) return 'permanent-deletion-unsupported';
    const binding = this.store.binding(entry.entryId);
    if (!binding || !plan.binding) return 'lifecycle-unbound';
    if (!sameBinding(binding, plan.binding) || capabilitiesKey(capabilities) !== capabilitiesKey(binding.capabilities)) return 'lifecycle-changed';
    const observed = await this.ownerCall(() => this.options.owner!.inspect(plan.sessionId));
    if (observed === null || !lifecycleEqual(binding.lifecycle, lifecycleKeySchema.parse(observed))) return 'lifecycle-changed';
    if ((await this.hooks.activity(plan.sessionId)).length) return 'session-active';
    // activity() yields; capture archive invalidation and entry replacement once more.
    if (this.hooks.invalidated(entry.entryId) || this.hooks.entry(plan.sessionId)?.entryId !== entry.entryId
      || !(await this.hooks.archived(plan.sessionId))) return 'archive-changed';
    if (requireManifest && !plan.manifest) return 'resource-manifest-required';
    return null;
  }
  private validateManifest(binding: RetirementBinding, manifest: RetirementManifest): void {
    if (!lifecycleEqual(binding.lifecycle, manifest.lifecycle)
      || capabilitiesKey(binding.capabilities) !== capabilitiesKey(manifest.capabilities)) {
      throw new Error('Resource manifest does not belong to the bound owner and lifecycle.');
    }
  }
  private validateOwnerState(plan: PurgePlan, input: RetirementState, authorizationId: string | null): RetirementState {
    const state = retirementStateSchema.parse(input);
    if (canonical(state.request) !== canonical(requestFor(plan))
      || retirementManifestDigest(state.manifest) !== retirementManifestDigest(plan.manifest!)
      || (state.authorizationId !== null && (authorizationId === null || state.authorizationId !== authorizationId))) {
      throw new Error('Owner receipt changed the operation, lifecycle, Bin binding, resource manifest or Host authorization grant.');
    }
    return state;
  }
  private async recover(operation: PurgeOperation, resume = true): Promise<PurgeResult> {
    // A locally persisted complete owner receipt needs no provider or native
    // existence observation: only the matching plugin entry remains to commit.
    if (operation.ownerState?.phase === 'done') return this.finalize(operation);
    const capabilities = await this.admittedCapabilities();
    if (!capabilities || !operation.plan.binding
      || capabilitiesKey(capabilities) !== capabilitiesKey(operation.plan.binding.capabilities)) {
      return this.pendingResult(operation, 'retirement-owner-unavailable');
    }
    const observed = await this.ownerCall(() => this.options.owner!.getOperation(operation.plan.operationId));
    if (observed === null) {
      if (operation.ownerState !== null) throw new Error('Resource owner lost a previously acknowledged durable operation.');
      return this.finish(operation, 'conflict', 'interrupted');
    }
    const state = this.validateOwnerState(operation.plan, observed, operation.authorizationId);
    if (['done', 'rejected', 'conflict'].includes(state.phase)) return this.acceptState(operation, state);
    this.assertProgress(operation.ownerState, state);
    if (!resume) {
      if (operation.ownerState && canonical(operation.ownerState) === canonical(state) && operation.result) {
        return purgeResultSchema.parse(operation.result);
      }
      return this.acceptState(operation, state);
    }
    // Persist the durable admission we have actually observed BEFORE recovery
    // can yield, erase another resource or fail. A later null/refusal cannot
    // erase this witness and release a half-retired entry.
    await this.acceptState(operation, state);
    const witnessed = this.store.operation(operation.plan.operationId)!;
    const recovered = this.validateOwnerState(operation.plan,
      await this.ownerCall(() => this.options.owner!.recover(operation.plan.operationId)), operation.authorizationId);
    this.assertProgress(state, recovered);
    return this.acceptState(witnessed, recovered);
  }
  private assertProgress(previous: RetirementState | null, next: RetirementState): void {
    if (!previous) return;
    const phases = ['fenced', 'quiesced', 'erasing', 'converging', 'done'];
    if (phases.indexOf(next.phase) < phases.indexOf(previous.phase)) throw new Error('Resource owner regressed a durable retirement phase.');
    for (const receipt of previous.resources.filter(item => item.status !== 'failed')) {
      const current = next.resources.find(item => item.ownerId === receipt.ownerId && item.resourceId === receipt.resourceId);
      if (!current || canonical(current) !== canonical(receipt)) throw new Error('Resource owner lost an acknowledged resource receipt.');
    }
  }
  private async acceptState(operation: PurgeOperation, state: RetirementState): Promise<PurgeResult> {
    this.assertProgress(operation.ownerState, state);
    if (state.phase === 'rejected' || state.phase === 'conflict') {
      return this.finish({ ...operation, ownerState: state }, state.phase, state.reason!);
    }
    const result = purgeResultSchema.parse({ action: 'purge', operationId: operation.plan.operationId,
      sessionId: operation.plan.sessionId, entryId: operation.entry!.entryId,
      status: state.resources.some(item => item.status === 'failed') ? 'partial-failure' : 'pending-recovery',
      reason: state.resources.some(item => item.status === 'failed') ? 'resource-failure' : 'owner-incomplete', ownerState: state });
    const saved: PurgeOperation = { ...operation, phase: 'owner-pending', ownerState: state, result };
    // Preserve the validated owner receipt BEFORE any plugin entry mutation.
    await this.store.putOperation(saved);
    return state.phase === 'done' ? this.finalize(saved) : result;
  }
  private pendingResult(operation: PurgeOperation, reason: string): PurgeResult {
    return purgeResultSchema.parse({ action: 'purge', operationId: operation.plan.operationId,
      sessionId: operation.plan.sessionId, entryId: operation.entry!.entryId,
      status: 'pending-recovery', reason, ownerState: operation.ownerState });
  }
  private async finalize(operation: PurgeOperation): Promise<PurgeResult> {
    const current = this.hooks.entry(operation.plan.sessionId);
    if (current?.entryId === operation.entry!.entryId) {
      await externalCall('Retirement entry commit failed', () => this.hooks.deleteEntry(current.sessionId));
    }
    return this.finish(operation, 'success', null);
  }
  private async finish(operation: PurgeOperation, status: 'success' | 'rejected' | 'conflict', reason: string | null): Promise<PurgeResult> {
    const result = purgeResultSchema.parse({ action: 'purge', operationId: operation.plan.operationId,
      sessionId: operation.plan.sessionId, entryId: operation.entry?.entryId ?? null,
      status, reason, ownerState: operation.ownerState });
    await this.store.putOperation({ ...operation, phase: 'done', result });
    return result;
  }
}
