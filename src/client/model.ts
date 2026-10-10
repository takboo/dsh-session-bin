import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client';
import { planSchema } from '../operations/schema.js';
import type { BinPlan } from '../operations/schema.js';
import { archivePlanSchema } from '../operations/archive.js';
import type { ArchiveEntry, ArchivePlan, ArchiveResult } from '../operations/archive.js';
import { snapshotSchema, nativePurgePlanSchema, purgeOperationsSchema } from '../remote/contracts.js';
import { purgeOperationSchema, purgeResultSchema, lifecycleEqual } from '../operations/retirement.js';
import type { PurgePlan, PurgeResult, PurgeOperation, RetirementState } from '../operations/retirement.js';
import type { SessionBinRemoteApi, BinSnapshot } from '../remote/contracts.js';
import { canonicalRetirementManifest, retirementManifestDigest } from './retirement-digest.js';
import { clonePurgeBatch, countPurgeBatchResources, emptyPurgeBatchResourceCounts } from './purge-batch.js';
import type { PurgeBatchItem, PurgeBatchScope, PurgeBatchState, PurgeClientOutcome } from './purge-batch.js';

export { retirementManifestDigest } from './retirement-digest.js';
export type { PurgeBatchItem, PurgeBatchScope, PurgeBatchState, PurgeClientOutcome } from './purge-batch.js';

// Legacy plans remain query-only, including on explicit user retry.
export type PendingPlan = ArchivePlan | BinPlan;
export interface ClientOutcome {
  sessionId: string;
  entryId: string | null;
  status: ArchiveResult['status'] | 'pending';
  reason: string | null;
}
export interface BinNotice {
  sequence: number;
  kind: 'unarchived' | 'deleted' | 'failed';
  sessionId: string;
  entryId: string | null;
  reason: string | null;
}
export interface PurgeConfirmation { plan: PurgePlan; title: string; acknowledged: boolean }
export interface DeletionPreferences {
  load(): boolean;
  save(confirm: boolean): void;
  subscribe?(listener: (confirm: boolean) => void): () => void;
}
export interface BinClientState {
  phase: 'loading' | 'ready' | 'error';
  entries: readonly ArchiveEntry[];
  busy: readonly string[];
  pending: readonly PendingPlan[];
  results: readonly ClientOutcome[];
  error: string | null;
  notice: BinNotice | null;
  purgeConfirmation: PurgeConfirmation | null;
  purgePending: readonly PurgePlan[];
  purgeResults: readonly PurgeClientOutcome[];
  purgeBatch: PurgeBatchState | null;
  purgeBatchOperationIds: readonly string[];
  purgeCacheBlocked: boolean;
  confirmDeletion: boolean;
}
export interface PurgeGrantSnapshot { operationId: string; authorizationId: string }
export interface PurgeGrantObservationSnapshot { operationId: string }
export interface PendingCache {
  load(): unknown;
  save(plans: readonly PendingPlan[]): void;
  loadPurge?(): unknown;
  savePurge?(plans: readonly PurgePlan[], batchOperationIds?: readonly string[]): void;
  loadPurgeGrants?(): unknown;
  savePurgeGrants?(grants: readonly PurgeGrantSnapshot[]): void;
  loadPurgeGrantObservations?(): unknown;
  stagePurgeGrantObservation?(operationId: string): void;
  loadPurgeBatchOperations?(): unknown;
  isPurgeCacheBlocked?(): boolean;
}
function value<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error('Session Bin Remote request failed.', { cause: result.error });
  return result.value;
}
function pendingPlans(raw: unknown): PendingPlan[] {
  if (!Array.isArray(raw)) return [];
  const valid: PendingPlan[] = [];
  for (const item of raw.slice(0, 64)) {
    const parsed = archivePlanSchema.safeParse(item);
    const plan = parsed.success ? parsed.data : planSchema.safeParse(item).data;
    if (plan && !valid.some(row => row.operationId === plan.operationId)) valid.push(plan);
  }
  return valid;
}

function purgePlans(raw: unknown): PurgePlan[] {
  if (!Array.isArray(raw)) return [];
  const valid: PurgePlan[] = [];
  for (const row of raw) {
    const parsed = nativePurgePlanSchema.safeParse(row);
    if (parsed.success && parsed.data.binding && parsed.data.manifest && parsed.data.expectedEntryId
      && !valid.some(plan => plan.operationId === parsed.data.operationId)) valid.push(parsed.data);
  }
  return valid;
}
function purgeGrantSnapshots(raw: unknown): PurgeGrantSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const valid: PurgeGrantSnapshot[] = [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const { operationId, authorizationId } = row as Record<string, unknown>;
    if (typeof operationId === 'string' && operationId.length > 0 && operationId.length <= 1024
      && typeof authorizationId === 'string' && uuid.test(authorizationId)
      && !valid.some(item => item.operationId === operationId)) valid.push({ operationId, authorizationId });
  }
  return valid;
}
function purgeGrantObservations(raw: unknown): PurgeGrantObservationSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const valid: PurgeGrantObservationSnapshot[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const { operationId } = row as Record<string, unknown>;
    if (typeof operationId === 'string' && operationId.length > 0 && operationId.length <= 1024
      && !valid.some(item => item.operationId === operationId)) valid.push({ operationId });
  }
  return valid;
}
function purgeBatchOperations(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((operationId): operationId is string => typeof operationId === 'string'
    && operationId.length > 0 && operationId.length <= 1024))];
}
function purgeCacheOverflow(...values: unknown[]): boolean {
  return values.some(value => Array.isArray(value) && value.length > 64);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function capabilitiesSnapshot(value: NonNullable<PurgePlan['binding']>['capabilities']) {
  return { ...value, participants: [...value.participants].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}
function manifestKey(value: NonNullable<PurgePlan['manifest']>): string {
  return canonicalRetirementManifest(value);
}
function frozenPurgeKey(plan: PurgePlan): string {
  return canonical([plan.schemaVersion, plan.action, plan.operationId, plan.sessionId, plan.expectedEntryId,
    plan.binding ? { ...plan.binding, capabilities: capabilitiesSnapshot(plan.binding.capabilities) } : null,
    plan.manifest ? manifestKey(plan.manifest) : null]);
}

interface PrivatePurgeConfirmation extends PurgeConfirmation {
  batchId: string | null;
  batchItemIndex: number | null;
  replacesOperationId: string | null;
}

/** One browser page model; native mutations only pass through the Host API. */
export class SessionBinClientModel {
  private state: BinClientState = {
    phase: 'loading', entries: [], busy: [], pending: [], results: [], error: null, notice: null,
    purgeConfirmation: null, purgePending: [], purgeResults: [], purgeBatch: null, purgeBatchOperationIds: [], purgeCacheBlocked: false, confirmDeletion: true,
  };
  private snapshot: BinClientState = structuredClone(this.state);
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private stream: RemoteStream<BinSnapshot> | undefined;
  private consumption: Promise<void> = Promise.resolve();
  private epoch = 0;
  private noticeSequence = 0;
  private readonly checking = new Set<string>();
  private readonly purgeExecuting = new Set<string>();
  private readonly purgeChecking = new Set<string>();
  private purgeDiscovering = false;
  private readonly settledPurgeIds = new Set<string>();
  private readonly observedPurgeGrants = new Map<string, string>();
  private readonly uncertainPurgeGrants = new Set<string>();
  private readonly unpersistedPurgeGrants = new Set<string>();
  private readonly batchPurgeOperationIds = new Set<string>();
  private confirmation: PrivatePurgeConfirmation | null = null;
  private purgeBatch: PurgeBatchState | null = null;
  private purgeBatchRun: Promise<PurgeBatchState | undefined> | null = null;
  private purgePreparationEpoch = 0;
  private stopPreferences: (() => void) | undefined;

  constructor(private readonly api: SessionBinRemoteApi,
    private readonly createStream: () => RemoteStream<BinSnapshot>, private readonly cache?: PendingCache, private readonly preferences?: DeletionPreferences) {
    try { this.state = { ...this.state, pending: pendingPlans(cache?.load()) }; }
    catch { /* A withheld cache does not prevent the page from connecting. */ }
    let purgePending: PurgePlan[] = [];
    let rawPurgePlans: unknown; let rawPurgeGrants: unknown; let rawPurgeObservations: unknown; let rawPurgeBatchOperations: unknown;
    try {
      rawPurgePlans = cache?.loadPurge?.();
      purgePending = purgePlans(rawPurgePlans);
      this.state = { ...this.state, purgePending, busy: [...new Set(purgePending.map(plan => plan.sessionId))] };
    } catch { /* A withheld deletion cache leaves in-memory operation protection available. */ }
    const pendingIds = new Set(purgePending.map(plan => plan.operationId));
    try {
      rawPurgeBatchOperations = cache?.loadPurgeBatchOperations?.();
      for (const operationId of purgeBatchOperations(rawPurgeBatchOperations)) {
        if (pendingIds.has(operationId)) this.batchPurgeOperationIds.add(operationId);
      }
      this.state = { ...this.state, purgeBatchOperationIds: [...this.batchPurgeOperationIds] };
    } catch { /* Missing provenance never weakens grant or pending-plan protection. */ }
    let grantsReadable = false; let observationsReadable = false;
    try {
      if (cache && typeof cache.loadPurgeGrants !== 'function') throw new Error('Grant cache unavailable.');
      rawPurgeGrants = cache?.loadPurgeGrants?.();
      for (const grant of purgeGrantSnapshots(rawPurgeGrants)) {
        if (pendingIds.has(grant.operationId)) this.observedPurgeGrants.set(grant.operationId, grant.authorizationId);
      }
      grantsReadable = Boolean(cache);
    } catch { /* A loaded pending plan without a readable grant is handled as uncertain below. */ }
    const observations = new Set<string>();
    try {
      if (cache && typeof cache.loadPurgeGrantObservations !== 'function') throw new Error('Grant observation cache unavailable.');
      rawPurgeObservations = cache?.loadPurgeGrantObservations?.();
      for (const observation of purgeGrantObservations(rawPurgeObservations)) {
        if (pendingIds.has(observation.operationId)) observations.add(observation.operationId);
      }
      observationsReadable = Boolean(cache);
    } catch { /* A missing attempt reader cannot prove that no grant was previously observed. */ }
    if (cache) {
      const canPersist = typeof cache.stagePurgeGrantObservation === 'function' && typeof cache.savePurgeGrants === 'function';
      for (const operationId of pendingIds) {
        if (!this.observedPurgeGrants.has(operationId)
          && (observations.has(operationId) || !grantsReadable || !observationsReadable || !canPersist)) {
          this.uncertainPurgeGrants.add(operationId);
        }
      }
    }
    const purgeCacheBlocked = Boolean(cache?.isPurgeCacheBlocked?.())
      || purgeCacheOverflow(rawPurgePlans, rawPurgeGrants, rawPurgeObservations, rawPurgeBatchOperations);
    this.state = { ...this.state, purgeCacheBlocked };
    try { this.state.confirmDeletion = preferences?.load() !== false; } catch { /* Confirmation stays on when storage is withheld. */ }
    this.snapshot = structuredClone(this.state);
    this.stopPreferences = preferences?.subscribe?.(confirmDeletion => this.publish({ confirmDeletion }));
  }
  setConfirmDeletion(confirmDeletion: boolean): void {
    try { this.preferences?.save(confirmDeletion); } catch { /* This page can still use the explicit preference. */ }
    this.publish({ confirmDeletion });
  }
  getSnapshot = (): BinClientState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: Partial<BinClientState>): void {
    if (this.lifetime.signal.aborted) return;
    this.state = { ...this.state, ...next };
    this.snapshot = structuredClone(this.state);
    for (const listener of this.listeners) listener();
  }
  private persist(plans: readonly PendingPlan[]): void {
    try { this.cache?.save(plans); } catch { /* In-memory receipts still protect this page; storage may be withheld. */ }
  }
  private pending(plans: readonly PendingPlan[]): void { this.persist(plans); this.publish({ pending: plans }); }

  async refresh(): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    const epoch = ++this.epoch;
    this.publish({ phase: 'loading', error: null });
    await this.stream?.dispose();
    if (epoch !== this.epoch || this.lifetime.signal.aborted) return;
    const stream = this.createStream();
    this.stream = stream;
    this.consumption = (async () => {
      try {
        for await (const item of stream) {
          if (epoch !== this.epoch || item.signal.aborted || this.lifetime.signal.aborted) continue;
          const snapshot = snapshotSchema.parse(item.value);
          this.publish({ entries: snapshot.entries, phase: 'ready', error: null });
          item.accept();
          void this.checkPending(false);
          void this.checkPurgePending();
          void this.discoverPurgePending();
        }
      } catch {
        if (epoch === this.epoch) this.publish({ phase: 'error', error: 'connection-failed' });
      }
    })();
  }
  async dispose(): Promise<void> {
    this.stopPreferences?.();
    this.lifetime.abort();
    ++this.epoch;
    await this.stream?.dispose();
    await this.consumption;
    this.listeners.clear();
  }
  dismissNotice(): void { this.publish({ notice: null }); }

  private hasActivePurgeBatch(): boolean {
    return this.purgeBatch !== null && ['preparing', 'confirming', 'running', 'paused'].includes(this.purgeBatch.phase);
  }
  private isPurgeCacheBlocked(): boolean {
    const blocked = this.state.purgeCacheBlocked || Boolean(this.cache?.isPurgeCacheBlocked?.());
    if (blocked && !this.state.purgeCacheBlocked) this.publish({ purgeCacheBlocked: true });
    return blocked;
  }
  private rejectPurgeCacheCapacity(): boolean {
    if (!this.isPurgeCacheBlocked()) return false;
    this.publish({ error: 'purge-cache-capacity', purgeCacheBlocked: true });
    return true;
  }
  private publishPurgeBatch(): void {
    if (this.purgeBatch) this.purgeBatch.resourceCounts = countPurgeBatchResources(this.purgeBatch.items);
    this.publish({ purgeBatch: clonePurgeBatch(this.purgeBatch) });
  }

  private savePurgePending(plans: readonly PurgePlan[], batchOperationId: string | null = null): void {
    const snapshots = plans.map(plan => nativePurgePlanSchema.parse(plan));
    const activeIds = new Set(snapshots.map(plan => plan.operationId));
    if (this.isPurgeCacheBlocked()) {
      const removesGuard = this.state.purgePending.some(plan => !activeIds.has(plan.operationId));
      if (!removesGuard) this.publish({ purgePending: snapshots, purgeBatchOperationIds: [...this.batchPurgeOperationIds] });
      return;
    }
    if (batchOperationId && activeIds.has(batchOperationId)) this.batchPurgeOperationIds.add(batchOperationId);
    for (const operationId of this.batchPurgeOperationIds) {
      if (!activeIds.has(operationId)) this.batchPurgeOperationIds.delete(operationId);
    }
    for (const operationId of this.observedPurgeGrants.keys()) {
      if (!activeIds.has(operationId)) this.observedPurgeGrants.delete(operationId);
    }
    for (const operationId of this.uncertainPurgeGrants) {
      if (!activeIds.has(operationId)) this.uncertainPurgeGrants.delete(operationId);
    }
    for (const operationId of this.unpersistedPurgeGrants) {
      if (!activeIds.has(operationId)) this.unpersistedPurgeGrants.delete(operationId);
    }
    const batchOperationIds = [...this.batchPurgeOperationIds];
    try { this.cache?.savePurge?.(snapshots, batchOperationIds); }
    catch {
      if (this.cache?.isPurgeCacheBlocked?.()) this.publish({ purgeCacheBlocked: true });
      // Never abandon an in-memory pending operation when storage is withheld.
    }
    if ([...this.observedPurgeGrants.keys()].some(operationId => activeIds.has(operationId))) {
      try { this.persistPurgeGrants(activeIds); }
      catch {
        for (const operationId of this.observedPurgeGrants.keys()) {
          if (activeIds.has(operationId)) this.unpersistedPurgeGrants.add(operationId);
        }
      }
    }
    this.publish({ purgePending: snapshots, purgeBatchOperationIds: batchOperationIds });
  }
  private persistPurgeGrants(activeIds = new Set(this.state.purgePending.map(plan => plan.operationId))): void {
    if (this.isPurgeCacheBlocked()) throw new Error('Deletion cache capacity exceeded.');
    const grants = [...this.observedPurgeGrants]
      .filter(([operationId]) => activeIds.has(operationId))
      .map(([operationId, authorizationId]) => ({ operationId, authorizationId }));
    if (!this.cache) return;
    if (typeof this.cache.savePurgeGrants !== 'function') throw new Error('Grant cache unavailable.');
    this.cache.savePurgeGrants(grants);
  }
  private stagePurgeGrantObservation(operationId: string): void {
    if (this.isPurgeCacheBlocked()) throw new Error('Deletion cache capacity exceeded.');
    if (!this.cache) return;
    if (typeof this.cache.stagePurgeGrantObservation !== 'function') {
      this.uncertainPurgeGrants.add(operationId); throw new Error('Grant observation cache unavailable.');
    }
    try { this.cache.stagePurgeGrantObservation(operationId); }
    catch {
      this.uncertainPurgeGrants.add(operationId); throw new Error('Grant observation could not be saved.');
    }
  }
  private validatePurgeOwnerState(plan: PurgePlan, state: RetirementState): void {
    const manifestDigest = plan.manifest ? retirementManifestDigest(plan.manifest) : null;
    if (!plan.binding || !plan.manifest || state.request.operationId !== plan.operationId
      || state.request.bin.entryVersion !== 2 || state.request.bin.entryId !== plan.expectedEntryId
      || !lifecycleEqual(state.request.expected, plan.binding.lifecycle)
      || manifestKey(state.manifest) !== manifestKey(plan.manifest)
      || state.request.manifestDigest !== manifestDigest) {
      throw new Error('Deletion result changed its confirmed lifecycle or resource scope.');
    }
    const observed = this.observedPurgeGrants.get(plan.operationId);
    if (observed !== undefined && observed !== state.authorizationId) {
      throw new Error('Deletion result changed its observed Host authorization grant.');
    }
    if (this.uncertainPurgeGrants.has(plan.operationId)) {
      throw new Error('Deletion authorization continuity is uncertain.');
    }
    if (state.authorizationId === null) return;
    if (observed === undefined) {
      this.stagePurgeGrantObservation(plan.operationId);
      this.observedPurgeGrants.set(plan.operationId, state.authorizationId);
      this.unpersistedPurgeGrants.add(plan.operationId);
    }
    if (this.unpersistedPurgeGrants.has(plan.operationId)) {
      try {
        this.persistPurgeGrants();
        this.unpersistedPurgeGrants.delete(plan.operationId);
      } catch {
        throw new Error('Deletion authorization grant could not be saved.');
      }
    }
  }
  private purgeOutcome(plan: PurgePlan, status: PurgeClientOutcome['status'], reason: string | null): PurgeClientOutcome {
    const outcome = { operationId: plan.operationId, sessionId: plan.sessionId, entryId: plan.expectedEntryId, status, reason };
    this.publish({ purgeResults: [outcome, ...this.state.purgeResults.filter(row => row.operationId !== plan.operationId)].slice(0, 64) });
    const item = this.purgeBatch?.items.find(row => row.plan?.operationId === plan.operationId);
    if (item) {
      item.state = 'settled'; item.outcome = structuredClone(outcome); item.reason = reason;
      this.publishPurgeBatch();
    }
    return outcome;
  }
  private publishConfirmation(): void {
    const confirmation = this.confirmation;
    this.publish({ purgeConfirmation: confirmation ? {
      plan: nativePurgePlanSchema.parse(confirmation.plan), title: confirmation.title, acknowledged: confirmation.acknowledged,
    } : null });
  }
  private async requestPurgePlan(target: Pick<ArchiveEntry, 'sessionId' | 'entryId'>): Promise<{ plan: PurgePlan | null; reason: string | null }> {
    if (this.rejectPurgeCacheCapacity()) return { plan: null, reason: 'purge-cache-capacity' };
    try {
      const plan = nativePurgePlanSchema.parse(value(await this.api.preparePurge({ sessionId: target.sessionId,
        operationId: crypto.randomUUID() }, this.lifetime.signal)));
      this.lifetime.signal.throwIfAborted();
      if (plan.sessionId !== target.sessionId || plan.expectedEntryId !== target.entryId
        || !this.state.entries.some(row => row.sessionId === target.sessionId && row.entryId === target.entryId)) {
        return { plan: null, reason: 'entry-changed' };
      }
      return { plan: nativePurgePlanSchema.parse(plan), reason: null };
    } catch { return { plan: null, reason: 'connection-failed' }; }
  }
  /** Only a fresh user click can opt out of the presentation confirmation. */
  async requestPurge(entry: Pick<ArchiveEntry, 'sessionId' | 'entryId'>, title: string): Promise<void> {
    const skip = !this.state.confirmDeletion;
    const epoch = this.epoch;
    const plan = await this.preparePurge(entry, title);
    if (skip && !this.state.confirmDeletion && epoch === this.epoch && plan
      && this.confirmation?.plan.operationId === plan.operationId) {
      this.acknowledgePurge(true);
      await this.confirmPurge();
    }
  }
  async requestPurgeBatch(scope: PurgeBatchScope, titles: Readonly<Record<string, string>> = {}): Promise<void> {
    const skip = !this.state.confirmDeletion;
    const epoch = this.epoch;
    const batch = await this.preparePurgeBatch(scope, titles);
    if (skip && !this.state.confirmDeletion && epoch === this.epoch && batch?.phase === 'confirming'
      && this.purgeBatch?.batchId === batch.batchId && batch.items.some(item => item.state === 'ready')) {
      this.acknowledgePurgeBatch(true);
      await this.runPurgeBatch();
    }
  }
  async preparePurge(entry: Pick<ArchiveEntry, 'sessionId' | 'entryId'>, title: string): Promise<PurgePlan | null> {
    const target = { sessionId: entry.sessionId, entryId: entry.entryId, title };
    if (this.rejectPurgeCacheCapacity() || this.state.phase !== 'ready' || this.state.busy.includes(target.sessionId)
      || this.confirmation || this.hasActivePurgeBatch() || this.state.purgePending.length > 0
      || this.state.pending.some(plan => plan.schemaVersion === 2 && plan.sessionId === target.sessionId)
      || this.lifetime.signal.aborted) return null;
    this.publish({ busy: [...this.state.busy, target.sessionId], error: null });
    try {
      const prepared = await this.requestPurgePlan(target);
      if (!prepared.plan) { this.publish({ error: prepared.reason }); return null; }
      this.confirmation = { plan: prepared.plan, title: target.title, acknowledged: false,
        batchId: null, batchItemIndex: null, replacesOperationId: null };
      this.publishConfirmation();
      return nativePurgePlanSchema.parse(prepared.plan);
    } finally { this.publish({ busy: this.state.busy.filter(id => id !== target.sessionId) }); }
  }
  acknowledgePurge(acknowledged: boolean): void {
    if (!this.confirmation) return;
    this.confirmation = { ...this.confirmation, acknowledged };
    this.publishConfirmation();
  }
  cancelPurge(): void { this.confirmation = null; this.publishConfirmation(); }
  async confirmPurge(): Promise<PurgeClientOutcome | undefined> {
    const confirmation = this.confirmation;
    if (!confirmation?.acknowledged || confirmation.plan.blockers.length || !confirmation.plan.binding
      || !confirmation.plan.manifest || this.state.phase !== 'ready' || this.lifetime.signal.aborted
      || this.rejectPurgeCacheCapacity()) return;
    const connectionEpoch = this.epoch;
    const plan = nativePurgePlanSchema.parse(confirmation.plan);
    const replacedOperationId = confirmation.replacesOperationId;
    if (replacedOperationId === null) {
      if (this.state.purgePending.length > 0 || this.hasActivePurgeBatch()) return;
      this.cancelPurge();
      return this.runPurge(plan, false, connectionEpoch);
    }

    const previous = this.state.purgePending.find(row => row.operationId === replacedOperationId);
    const batch = confirmation.batchId === null ? null : this.purgeBatch;
    const item = batch && confirmation.batchItemIndex !== null ? batch.items[confirmation.batchItemIndex] : null;
    const associationIsCurrent = (): boolean => {
      const current = this.state.purgePending.find(row => row.operationId === replacedOperationId);
      if (this.confirmation !== confirmation || !current || frozenPurgeKey(current) !== frozenPurgeKey(previous!)
        || this.state.purgePending.some(row => row.operationId !== replacedOperationId)
        || this.observedPurgeGrants.has(replacedOperationId) || this.uncertainPurgeGrants.has(replacedOperationId)
        || plan.sessionId !== current.sessionId || plan.expectedEntryId !== current.expectedEntryId) return false;
      if (confirmation.batchId === null) return !this.hasActivePurgeBatch();
      return batch !== null && batch === this.purgeBatch && batch.batchId === confirmation.batchId
        && ((batch.phase === 'paused' && !batch.stopRequested) || (batch.phase === 'cancelled' && batch.stopRequested)) && item != null
        && batch.items[confirmation.batchItemIndex!] === item && item.state === 'settled'
        && item.plan?.operationId === replacedOperationId && item.outcome?.operationId === replacedOperationId
        && item.outcome.reason === 'deletion-result-missing'
        && item.target.sessionId === plan.sessionId && item.target.entryId === plan.expectedEntryId;
    };
    if (!previous || this.purgeExecuting.has(replacedOperationId) || this.purgeChecking.has(replacedOperationId)
      || !associationIsCurrent()) return;
    this.purgeChecking.add(replacedOperationId);
    try {
      if (await this.readPurgeOperation(previous) !== null) {
        if (associationIsCurrent()) this.publish({ error: 'deletion-pending' });
        return;
      }
    } catch {
      if (associationIsCurrent()) this.publish({ error: 'deletion-pending' });
      return;
    } finally { this.purgeChecking.delete(replacedOperationId); }
    if (this.state.phase !== 'ready' || this.epoch !== connectionEpoch || this.lifetime.signal.aborted || !associationIsCurrent()) return;

    const batchOrigin = this.batchPurgeOperationIds.has(replacedOperationId) || confirmation.batchId !== null;
    this.savePurgePending([
      ...this.state.purgePending.filter(row => row.operationId !== replacedOperationId), plan,
    ], batchOrigin ? plan.operationId : null);
    this.publish({ purgeResults: this.state.purgeResults.filter(row => row.operationId !== replacedOperationId) });
    if (item) {
      item.plan = plan; item.state = 'running'; item.outcome = null; item.reason = null;
      this.publishPurgeBatch();
    }
    this.cancelPurge();
    return this.runPurge(plan, batchOrigin, connectionEpoch);
  }
  async preparePurgeBatch(scope: PurgeBatchScope,
    titlesBySessionId: Readonly<Record<string, string>> = {}): Promise<PurgeBatchState | null> {
    if (this.rejectPurgeCacheCapacity() || this.state.phase !== 'ready' || this.confirmation
      || this.hasActivePurgeBatch() || this.state.purgePending.length > 0 || this.lifetime.signal.aborted) return null;
    const selected = scope.kind === 'selection' ? new Set(scope.entryIds) : null;
    const seen = new Set<string>();
    const targets = this.state.entries
      .filter(row => selected === null || selected.has(row.entryId))
      .filter(row => {
        const key = `${row.sessionId}\u0000${row.entryId}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      })
      .map(row => {
        const title = titlesBySessionId[row.sessionId];
        return { sessionId: row.sessionId, entryId: row.entryId, title: typeof title === 'string' ? title : row.sessionId };
      });
    if (!targets.length) return null;
    ++this.purgePreparationEpoch;
    const batch: PurgeBatchState = {
      batchId: crypto.randomUUID(), scope: scope.kind, phase: 'preparing', frozenCount: targets.length,
      acknowledged: false, stopRequested: false,
      items: targets.map(target => ({ target, state: 'preparing', plan: null, reason: null, outcome: null })),
      resourceCounts: emptyPurgeBatchResourceCounts(),
    };
    this.purgeBatch = batch;
    this.publish({ error: null }); this.publishPurgeBatch();
    for (let index = 0; index < batch.items.length; index += 1) {
      if (batch.stopRequested || this.lifetime.signal.aborted) break;
      const item = batch.items[index];
      if (!item) continue;
      if (this.state.pending.some(plan => plan.schemaVersion === 2 && plan.sessionId === item.target.sessionId)) {
        item.state = 'blocked'; item.reason = 'pending-result'; this.publishPurgeBatch(); continue;
      }
      this.publish({ busy: [...new Set([...this.state.busy, item.target.sessionId])] });
      const prepared = await this.requestPurgePlan(item.target);
      this.publish({ busy: this.state.busy.filter(id => id !== item.target.sessionId) });
      if (batch !== this.purgeBatch || batch.stopRequested || this.lifetime.signal.aborted) {
        item.state = 'cancelled'; item.reason = null; this.publishPurgeBatch(); break;
      }
      if (!prepared.plan) {
        item.state = 'blocked'; item.reason = prepared.reason; this.publishPurgeBatch(); continue;
      }
      item.plan = prepared.plan;
      if (prepared.plan.blockers.length || !prepared.plan.binding || !prepared.plan.manifest) {
        item.state = 'blocked'; item.reason = prepared.plan.blockers[0]?.code ?? 'deletion-not-ready';
      } else item.state = 'ready';
      this.publishPurgeBatch();
    }
    if (batch !== this.purgeBatch) return null;
    if (batch.stopRequested || this.lifetime.signal.aborted) {
      for (const item of batch.items) {
        if (item.state === 'preparing' || item.state === 'ready') item.state = 'cancelled';
      }
      batch.phase = 'cancelled';
    } else batch.phase = 'confirming';
    this.publishPurgeBatch();
    return clonePurgeBatch(batch);
  }
  acknowledgePurgeBatch(acknowledged: boolean): void {
    if (!this.purgeBatch || this.purgeBatch.phase !== 'confirming') return;
    this.purgeBatch.acknowledged = acknowledged; this.publishPurgeBatch();
  }
  async runPurgeBatch(): Promise<PurgeBatchState | undefined> {
    if (this.purgeBatchRun) return this.purgeBatchRun;
    const batch = this.purgeBatch;
    if (!batch || this.state.phase !== 'ready' || this.rejectPurgeCacheCapacity() || this.lifetime.signal.aborted || this.confirmation) return;
    if (batch.phase === 'confirming' && !batch.acknowledged) return;
    if (batch.phase !== 'confirming' && batch.phase !== 'paused') return;
    const terminal = (outcome: PurgeClientOutcome | null) => outcome !== null
      && ['success', 'rejected', 'conflict'].includes(outcome.status);
    if (batch.phase === 'paused' && batch.items.some(item => item.state === 'settled' && !terminal(item.outcome))) return;
    if (this.state.purgePending.length > 0) {
      batch.phase = 'paused'; this.publishPurgeBatch(); return clonePurgeBatch(batch) ?? undefined;
    }
    const connectionEpoch = this.epoch;
    batch.phase = 'running'; this.publishPurgeBatch();
    this.purgeBatchRun = (async () => {
      for (const item of batch.items) {
        if (batch !== this.purgeBatch || this.lifetime.signal.aborted) break;
        if (batch.stopRequested) break;
        if (item.state !== 'ready') continue;
        if (this.state.phase !== 'ready' || this.epoch !== connectionEpoch || this.state.purgePending.length > 0) {
          batch.phase = 'paused'; this.publishPurgeBatch(); return clonePurgeBatch(batch) ?? undefined;
        }
        const plan = item.plan;
        if (!plan) { item.state = 'blocked'; item.reason = 'deletion-not-ready'; this.publishPurgeBatch(); continue; }
        item.state = 'running'; item.reason = null; this.publishPurgeBatch();
        if (batch.stopRequested || this.lifetime.signal.aborted) { item.state = 'cancelled'; break; }
        if (this.state.phase !== 'ready' || this.epoch !== connectionEpoch) {
          item.state = 'ready'; batch.phase = 'paused'; this.publishPurgeBatch(); return clonePurgeBatch(batch) ?? undefined;
        }
        const outcome = await this.runPurge(plan, true, connectionEpoch);
        if (!terminal(outcome)) {
          batch.phase = batch.stopRequested ? 'cancelled' : 'paused';
          if (batch.stopRequested) {
            for (const unsent of batch.items) {
              if (unsent.state === 'preparing' || unsent.state === 'ready') unsent.state = 'cancelled';
            }
          }
          this.publishPurgeBatch(); return clonePurgeBatch(batch) ?? undefined;
        }
      }
      if (batch.stopRequested || this.lifetime.signal.aborted) {
        for (const item of batch.items) {
          if (item.state === 'preparing' || item.state === 'ready') item.state = 'cancelled';
        }
        batch.phase = 'cancelled';
      } else batch.phase = 'done';
      this.publishPurgeBatch(); return clonePurgeBatch(batch) ?? undefined;
    })();
    try { return await this.purgeBatchRun; }
    finally { this.purgeBatchRun = null; }
  }
  stopPurgeBatch(): void {
    if (!this.purgeBatch || !this.hasActivePurgeBatch()) return;
    const batch = this.purgeBatch;
    ++this.purgePreparationEpoch;
    if (this.confirmation?.batchId === batch.batchId) {
      this.confirmation = null;
      this.publishConfirmation();
    }
    batch.stopRequested = true;
    for (const item of batch.items) {
      if (item.state === 'preparing' || item.state === 'ready') item.state = 'cancelled';
    }
    if (batch.phase !== 'preparing'
      && (batch.phase !== 'running' || !batch.items.some(item => item.state === 'running'))) {
      batch.phase = 'cancelled';
    }
    this.publishPurgeBatch();
  }
  dismissPurgeBatch(): void {
    if (!this.purgeBatch || !['done', 'cancelled'].includes(this.purgeBatch.phase)) return;
    ++this.purgePreparationEpoch;
    if (this.confirmation?.batchId === this.purgeBatch.batchId) this.cancelPurge();
    this.purgeBatch = null; this.publishPurgeBatch();
  }
  private async readPurgeOperation(plan: PurgePlan): Promise<PurgeOperation | null> {
    const raw = value(await this.api.getPurgeOperation(plan.operationId, this.lifetime.signal));
    if (raw === null) {
      if (this.observedPurgeGrants.has(plan.operationId) || this.uncertainPurgeGrants.has(plan.operationId)) {
        throw new Error('An admitted deletion lost its saved Host journal.');
      }
      return null;
    }
    const operation = purgeOperationSchema.parse(raw);
    if (operation.schemaVersion !== 2 || frozenPurgeKey(operation.plan) !== frozenPurgeKey(plan)) throw new Error('Deletion receipt changed its confirmed binding.');
    if (this.uncertainPurgeGrants.has(plan.operationId)) throw new Error('Deletion authorization continuity is uncertain.');
    const observed = this.observedPurgeGrants.get(plan.operationId);
    if (observed !== undefined && operation.authorizationId !== observed) throw new Error('Deletion journal lost its observed authorization grant.');
    if (operation.ownerState) this.validatePurgeOwnerState(plan, operation.ownerState);
    return operation;
  }
  private async discoverPurgePending(): Promise<void> {
    if (this.purgeDiscovering || this.lifetime.signal.aborted || typeof this.api.purgeOperations !== 'function') return;
    this.purgeDiscovering = true;
    try {
      const operations = purgeOperationsSchema.parse(value(await this.api.purgeOperations(this.lifetime.signal)));
      this.lifetime.signal.throwIfAborted();
      for (const operation of operations.filter(row => row.schemaVersion === 2 && row.phase !== 'done')) {
        const plan = nativePurgePlanSchema.parse(operation.plan);
        if (this.settledPurgeIds.has(plan.operationId) || this.purgeExecuting.has(plan.operationId) || this.purgeChecking.has(plan.operationId)) continue;
        const existing = this.state.purgePending.find(row => row.operationId === plan.operationId);
        if (existing && frozenPurgeKey(existing) !== frozenPurgeKey(plan)) throw new Error('Discovered deletion changed its confirmed binding.');
        if (!existing) this.savePurgePending([...this.state.purgePending, plan]);
        this.publish({ busy: [...new Set([...this.state.busy, plan.sessionId])] });
        if (operation.result) this.settlePurge(plan, operation.result, false);
        else { this.purgeOutcome(plan, 'pending', 'deletion-pending'); this.publish({ error: 'deletion-pending' }); }
      }
    } catch { this.publish({ error: 'deletion-pending' }); }
    finally { this.purgeDiscovering = false; }
  }

  /** Automatic checks and reload only observe; no missing or unfinished deletion is replayed. */
  async checkPurgePending(): Promise<void> {
    for (const plan of [...this.state.purgePending]) {
      if (this.purgeExecuting.has(plan.operationId) || this.purgeChecking.has(plan.operationId) || this.lifetime.signal.aborted) continue;
      this.purgeChecking.add(plan.operationId);
      try {
        const operation = await this.readPurgeOperation(plan);
        if (operation?.result) this.settlePurge(plan, operation.result, false);
        else {
          const reason = operation === null ? 'deletion-result-missing' : 'deletion-pending';
          this.purgeOutcome(plan, 'pending', reason); this.publish({ error: reason });
        }
      } catch { this.publish({ error: this.isPurgeCacheBlocked() ? 'purge-cache-capacity' : 'deletion-pending' }); }
      finally { this.purgeChecking.delete(plan.operationId); }
    }
  }
  /** Explicit continuation may only submit a known saved operation's original plan. */
  async retryPurge(operationId: string): Promise<PurgeClientOutcome | undefined> {
    const plan = this.state.purgePending.find(row => row.operationId === operationId);
    if (this.rejectPurgeCacheCapacity() || this.state.phase !== 'ready' || !plan || this.purgeExecuting.has(operationId)
      || this.purgeChecking.has(operationId) || this.lifetime.signal.aborted) return;
    const connectionEpoch = this.epoch;
    this.purgeChecking.add(operationId);
    try {
      const operation = await this.readPurgeOperation(plan);
      this.lifetime.signal.throwIfAborted();
      if (operation === null) {
        this.publish({ error: 'deletion-result-missing' });
        return this.purgeOutcome(plan, 'pending', 'deletion-result-missing');
      }
      if (operation.phase === 'done' && operation.result) return this.settlePurge(plan, operation.result);
      if (this.state.phase !== 'ready' || this.epoch !== connectionEpoch) {
        return this.purgeOutcome(plan, 'pending', 'connection-failed');
      }
      return await this.runPurge(plan, false, connectionEpoch);
    } catch { this.publish({ error: 'deletion-pending' }); return this.purgeOutcome(plan, 'pending', 'deletion-pending'); }
    finally { this.purgeChecking.delete(operationId); }
  }
  /** A confirmed missing operation requires fresh preparation and another explicit confirmation. */
  async preparePurgeAgain(operationId: string, title: string): Promise<PurgePlan | null> {
    const previous = this.state.purgePending.find(plan => plan.operationId === operationId);
    const belongsToBatch = this.batchPurgeOperationIds.has(operationId);
    const batch = this.purgeBatch;
    const batchItemIndex = batch?.items.findIndex(item => item.plan?.operationId === operationId) ?? -1;
    const item = batch && batchItemIndex >= 0 ? batch.items[batchItemIndex] : null;
    const batchReplacement = belongsToBatch && batch !== null
      && ((batch.phase === 'paused' && !batch.stopRequested) || (batch.phase === 'cancelled' && batch.stopRequested))
      && item?.state === 'settled' && item.outcome?.operationId === operationId
      && item.outcome.reason === 'deletion-result-missing';
    if (this.rejectPurgeCacheCapacity() || this.state.phase !== 'ready' || !previous || this.confirmation || this.purgeExecuting.has(operationId)
      || this.purgeChecking.has(operationId) || this.lifetime.signal.aborted
      || (this.hasActivePurgeBatch() && !batchReplacement)
      || this.state.purgePending.some(plan => plan.operationId !== operationId)) return null;
    const connectionEpoch = this.epoch;
    const preparationEpoch = ++this.purgePreparationEpoch;
    const associationIsCurrent = (): boolean => {
      const current = this.state.purgePending.find(plan => plan.operationId === operationId);
      if (this.state.phase !== 'ready' || this.epoch !== connectionEpoch || preparationEpoch !== this.purgePreparationEpoch || this.confirmation !== null || !current
        || frozenPurgeKey(current) !== frozenPurgeKey(previous)
        || this.state.purgePending.some(plan => plan.operationId !== operationId)) return false;
      if (!batchReplacement) return !this.hasActivePurgeBatch();
      return batch !== null && batch === this.purgeBatch
        && ((batch.phase === 'paused' && !batch.stopRequested) || (batch.phase === 'cancelled' && batch.stopRequested))
        && batch.items[batchItemIndex] === item && item?.state === 'settled'
        && item.plan?.operationId === operationId && item.outcome?.operationId === operationId
        && item.outcome.reason === 'deletion-result-missing';
    };
    this.purgeChecking.add(operationId);
    try {
      const operation = await this.readPurgeOperation(previous);
      if (!associationIsCurrent()) return null;
      if (operation !== null) { this.publish({ error: 'deletion-pending' }); return null; }
      this.lifetime.signal.throwIfAborted();
      const entry = this.state.entries.find(row => row.sessionId === previous.sessionId && row.entryId === previous.expectedEntryId);
      if (!entry) { this.publish({ error: 'entry-changed' }); return null; }
      const prepared = await this.requestPurgePlan(entry);
      if (!associationIsCurrent()) return null;
      if (!prepared.plan) { this.publish({ error: prepared.reason }); return null; }
      this.publish({ error: null });
      if (!associationIsCurrent()) return null;
      this.confirmation = { plan: prepared.plan, title, acknowledged: false,
        batchId: batchReplacement ? batch.batchId : null,
        batchItemIndex: batchReplacement ? batchItemIndex : null,
        replacesOperationId: operationId };
      this.publishConfirmation();
      return nativePurgePlanSchema.parse(prepared.plan);
    } catch {
      if (associationIsCurrent()) this.publish({ error: 'deletion-pending' });
      return null;
    } finally { this.purgeChecking.delete(operationId); }
  }
  async discardMissingPurge(operationId: string): Promise<boolean> {
    const plan = this.state.purgePending.find(row => row.operationId === operationId);
    const belongsToBatch = this.batchPurgeOperationIds.has(operationId)
      || (this.purgeBatch?.items.some(item => item.plan?.operationId === operationId) ?? false);
    if (this.rejectPurgeCacheCapacity() || belongsToBatch || !plan || this.purgeExecuting.has(operationId)
      || this.purgeChecking.has(operationId) || this.lifetime.signal.aborted) return false;
    this.purgeChecking.add(operationId);
    try {
      if (await this.readPurgeOperation(plan) !== null) return false;
      this.lifetime.signal.throwIfAborted();
      this.savePurgePending(this.state.purgePending.filter(row => row.operationId !== operationId));
      if (!this.state.purgePending.some(row => row.sessionId === plan.sessionId)) this.publish({ busy: this.state.busy.filter(id => id !== plan.sessionId) });
      this.publish({ error: this.state.purgePending.length ? 'deletion-pending' : null });
      return true; // No prepare or execute: any new target requires a new explicit selection and confirmation.
    } catch { this.publish({ error: 'deletion-pending' }); return false; }
    finally { this.purgeChecking.delete(operationId); }
  }

  private settlePurge(plan: PurgePlan, raw: PurgeResult, announce = true): PurgeClientOutcome {
    const result = purgeResultSchema.parse(raw);
    const admitted = ['success', 'pending-recovery', 'partial-failure'].includes(result.status);
    if (result.operationId !== plan.operationId || result.sessionId !== plan.sessionId
      || (result.entryId !== null && result.entryId !== plan.expectedEntryId)
      || (admitted && result.entryId !== plan.expectedEntryId)) {
      throw new Error('Deletion result changed its confirmed lifecycle or resource scope.');
    }
    if (this.uncertainPurgeGrants.has(plan.operationId)) throw new Error('Deletion authorization continuity is uncertain.');
    if (this.observedPurgeGrants.has(plan.operationId)
      && (result.status === 'rejected' || result.status === 'conflict' || !result.ownerState)) {
      throw new Error('An admitted deletion cannot lose its observed owner authorization.');
    }
    if (result.ownerState) this.validatePurgeOwnerState(plan, result.ownerState);
    const terminal = ['success', 'rejected', 'conflict'].includes(result.status);
    const cacheBlocked = this.isPurgeCacheBlocked();
    if (terminal && !cacheBlocked) {
      this.settledPurgeIds.add(plan.operationId);
      this.savePurgePending(this.state.purgePending.filter(row => row.operationId !== plan.operationId));
      this.publish({ busy: this.state.busy.filter(id => id !== plan.sessionId) });
    }
    const outcome = this.purgeOutcome(plan, result.status, result.reason);
    this.publish({ error: cacheBlocked ? 'purge-cache-capacity'
      : terminal ? this.state.purgePending.length ? 'deletion-pending' : null : 'deletion-pending' });
    if (!cacheBlocked && (announce || terminal)) this.publish({ notice: { sequence: ++this.noticeSequence,
      kind: result.status === 'success' ? 'deleted' : 'failed', sessionId: result.sessionId, entryId: result.entryId,
      reason: terminal ? result.reason : 'deletion-pending' } });
    return outcome;
  }
  private async runPurge(input: PurgePlan, batchOrigin = false, connectionEpoch = this.epoch): Promise<PurgeClientOutcome> {
    const plan = nativePurgePlanSchema.parse(input);
    const alreadyPending = this.state.purgePending.some(row => row.operationId === plan.operationId);
    const cacheBlocked = this.rejectPurgeCacheCapacity();
    if (cacheBlocked || (this.state.purgePending.length > 0 && !alreadyPending)
      || this.purgeExecuting.has(plan.operationId) || this.lifetime.signal.aborted) {
      return this.purgeOutcome(plan, 'pending', cacheBlocked ? 'purge-cache-capacity' : 'deletion-pending');
    }
    this.purgeExecuting.add(plan.operationId);
    this.publish({ busy: [...new Set([...this.state.busy, plan.sessionId])], error: null });
    this.savePurgePending([...this.state.purgePending.filter(row => row.operationId !== plan.operationId), plan],
      batchOrigin ? plan.operationId : null);
    try {
      this.lifetime.signal.throwIfAborted();
      if (this.state.phase !== 'ready' || this.epoch !== connectionEpoch) {
        this.publish({ error: 'connection-failed' });
        return this.purgeOutcome(plan, 'pending', 'connection-failed');
      }
      return this.settlePurge(plan, value(await this.api.executePurge(nativePurgePlanSchema.parse(plan), this.lifetime.signal)));
    } catch {
      try {
        const operation = await this.readPurgeOperation(plan);
        if (operation?.result) return this.settlePurge(plan, operation.result);
        if (operation === null) { this.publish({ error: 'deletion-result-missing' }); return this.purgeOutcome(plan, 'pending', 'deletion-result-missing'); }
      } catch { /* An unknown deletion stays guarded until a matching owner receipt is observed. */ }
      this.publish({ error: 'deletion-pending' }); return this.purgeOutcome(plan, 'pending', 'deletion-pending');
    } finally {
      this.purgeExecuting.delete(plan.operationId);
      if (!this.state.purgePending.some(row => row.sessionId === plan.sessionId)) this.publish({ busy: this.state.busy.filter(id => id !== plan.sessionId) });
    }
  }

  async unarchive(entry: Pick<ArchiveEntry, 'sessionId' | 'entryId'>): Promise<ClientOutcome> {
    return this.run(entry.sessionId, entry.entryId);
  }
  async unarchiveMany(entries: readonly ArchiveEntry[]): Promise<ClientOutcome[]> {
    // Freeze the click's selection. Later incoming entries never join this batch.
    const targets = entries.map(entry => ({ sessionId: entry.sessionId, entryId: entry.entryId }));
    const results: ClientOutcome[] = [];
    for (const target of targets) {
      if (this.lifetime.signal.aborted) break;
      results.push(await this.unarchive(target));
    }
    this.publish({ results });
    return results;
  }

  /** Baselines only query receipts. Explicit retry can resend the same missing
   * v2 unarchive identity/plan; v1 bin/restore plans remain query-only forever.
   */
  async checkPending(retryMissing = true): Promise<void> {
    for (const plan of [...this.state.pending]) {
      if (this.checking.has(plan.operationId) || this.state.busy.includes(plan.sessionId) || this.lifetime.signal.aborted) continue;
      this.checking.add(plan.operationId);
      try {
        const operation = value(await this.api.getOperation(plan.operationId, this.lifetime.signal));
        if (operation?.result) {
          if (operation.plan.operationId !== plan.operationId || operation.plan.sessionId !== plan.sessionId
            || operation.plan.action !== plan.action || operation.schemaVersion !== plan.schemaVersion) throw new Error('Receipt identity changed.');
          if (plan.schemaVersion === 1) {
            // Historical bin success does not prove that this page unarchived a
            // conversation. Clear its unknown status without a misleading Toast.
            this.pending(this.state.pending.filter(row => row.operationId !== plan.operationId));
            this.publish({ error: this.state.pending.length ? 'pending-result' : null });
          } else if (operation.result.action === 'unarchive') this.settle(plan, operation.result);
        } else if (operation === null && retryMissing && plan.schemaVersion === 2) {
          this.settle(plan, value(await this.api.execute(plan, this.lifetime.signal)));
        } else if (plan.schemaVersion === 1) this.publish({ error: 'legacy-pending' });
      } catch { this.publish({ error: 'pending-result' }); }
      finally { this.checking.delete(plan.operationId); }
    }
  }
  private settle(plan: ArchivePlan, result: ArchiveResult): ClientOutcome {
    if (result.operationId !== plan.operationId || result.sessionId !== plan.sessionId || result.action !== plan.action
      || (result.status === 'success' && result.entryId !== plan.expected.entryId)) {
      throw new Error('Receipt identity changed.');
    }
    const outcome: ClientOutcome = {
      sessionId: result.sessionId, entryId: result.entryId, status: result.status, reason: result.reason,
    };
    this.pending(this.state.pending.filter(row => row.operationId !== plan.operationId));
    this.publish({
      results: [outcome],
      error: this.state.pending.length ? 'pending-result' : null,
      notice: {
        sequence: ++this.noticeSequence,
        kind: result.status === 'success' ? 'unarchived' : 'failed',
        sessionId: result.sessionId, entryId: result.entryId, reason: result.reason,
      },
    });
    return outcome;
  }
  private async run(sessionId: string, expectedEntryId: string): Promise<ClientOutcome> {
    if (this.state.phase !== 'ready' || this.state.busy.includes(sessionId)
      || this.state.pending.some(plan => plan.schemaVersion === 2 && plan.sessionId === sessionId) || this.lifetime.signal.aborted) {
      return { sessionId, entryId: expectedEntryId, status: 'pending', reason: 'pending-result' };
    }
    this.publish({ busy: [...this.state.busy, sessionId], error: null });
    let plan: ArchivePlan | undefined;
    try {
      plan = archivePlanSchema.parse(value(await this.api.prepare({ action: 'unarchive', sessionId, operationId: crypto.randomUUID() }, this.lifetime.signal)));
      if (plan.sessionId !== sessionId || plan.expected.entryId !== expectedEntryId) {
        const result: ArchiveResult = { operationId: plan.operationId, action: 'unarchive', sessionId: plan.sessionId, entryId: expectedEntryId,
          status: 'conflict', reason: 'entry-changed' };
        return this.settle(plan, result);
      }
      this.pending([...this.state.pending, plan]);
      return this.settle(plan, value(await this.api.execute(plan, this.lifetime.signal)));
    } catch {
      if (plan) {
        try {
          const operation = value(await this.api.getOperation(plan.operationId, this.lifetime.signal));
          if (operation?.schemaVersion === 2 && operation.result) return this.settle(plan, operation.result);
        } catch { /* Preserve the saved plan until a confirmed receipt arrives. */ }
      }
      const outcome: ClientOutcome = { sessionId, entryId: expectedEntryId,
        status: plan ? 'pending' : 'rejected', reason: plan ? 'pending-result' : 'connection-failed' };
      this.publish({ error: outcome.reason, results: [outcome], notice: {
        sequence: ++this.noticeSequence, kind: 'failed', sessionId, entryId: outcome.entryId, reason: outcome.reason,
      } });
      return outcome;
    } finally { this.publish({ busy: this.state.busy.filter(id => id !== sessionId) }); }
  }
}

export function browserPendingCache(storage: Storage): PendingCache {
  const key = 'dsh-session-bin.pending.v2';
  const legacyKey = 'dsh-session-bin.pending.v1';
  const purgeKey = 'dsh-session-bin.purge.pending.v2';
  const purgeGrantKey = 'dsh-session-bin.purge.grants.v2';
  interface PurgePendingEnvelope {
    schemaVersion: 1;
    plans: PurgePlan[];
    grants: PurgeGrantSnapshot[];
    observationAttempts: PurgeGrantObservationSnapshot[];
    batchOperations: string[];
  }
  let purgeCacheBlocked = false;
  const emptyPurgeEnvelope = (): PurgePendingEnvelope => ({
    schemaVersion: 1, plans: [], grants: [], observationAttempts: [], batchOperations: [],
  });
  const parse = (item: string | null): PendingPlan[] => {
    try { return pendingPlans(JSON.parse(item ?? '[]')); } catch { return []; }
  };
  const assertPurgeCacheWritable = (...arrays: (readonly unknown[])[]): void => {
    if (arrays.some(array => array.length > 64)) purgeCacheBlocked = true;
    if (purgeCacheBlocked) throw new Error('Deletion cache capacity exceeded.');
  };
  const writePurgeEnvelope = (envelope: PurgePendingEnvelope): void => {
    assertPurgeCacheWritable(envelope.plans, envelope.grants, envelope.observationAttempts, envelope.batchOperations);
    storage.setItem(purgeKey, JSON.stringify(envelope));
    storage.removeItem(purgeGrantKey);
  };
  const readPurgeEnvelope = (): PurgePendingEnvelope => {
    const encoded = storage.getItem(purgeKey);
    let raw: unknown = null;
    try { raw = JSON.parse(encoded ?? 'null'); } catch { /* A malformed primary cache supplies no trusted records. */ }
    const legacyEncoded = storage.getItem(purgeGrantKey);
    let rawLegacyGrants: unknown = [];
    try { rawLegacyGrants = JSON.parse(legacyEncoded ?? '[]'); } catch { /* Malformed legacy grants are not trusted. */ }
    const legacyArray = encoded !== null && Array.isArray(raw);
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const rawPlans = legacyArray ? raw : record?.schemaVersion === 1 ? record.plans : [];
    const rawGrants = record?.schemaVersion === 1 ? record.grants : [];
    const rawObservations = record?.schemaVersion === 1 ? record.observationAttempts : [];
    const rawBatchOperations = record?.schemaVersion === 1 ? record.batchOperations : [];
    if (purgeCacheOverflow(rawPlans, rawGrants, rawObservations, rawBatchOperations, rawLegacyGrants)) purgeCacheBlocked = true;
    let envelope = emptyPurgeEnvelope();
    if (legacyArray) envelope.plans = purgePlans(rawPlans);
    else if (record?.schemaVersion === 1) {
      envelope = {
        schemaVersion: 1,
        plans: purgePlans(rawPlans),
        grants: purgeGrantSnapshots(rawGrants),
        observationAttempts: purgeGrantObservations(rawObservations),
        batchOperations: purgeBatchOperations(rawBatchOperations),
      };
    }
    const activeIds = new Set(envelope.plans.map(plan => plan.operationId));
    envelope.grants = purgeGrantSnapshots([...envelope.grants, ...purgeGrantSnapshots(rawLegacyGrants)])
      .filter(grant => activeIds.has(grant.operationId));
    envelope.observationAttempts = purgeGrantObservations(envelope.observationAttempts)
      .filter(observation => activeIds.has(observation.operationId));
    envelope.batchOperations = purgeBatchOperations(envelope.batchOperations)
      .filter(operationId => activeIds.has(operationId));
    if (legacyArray) {
      const grantedIds = new Set(envelope.grants.map(grant => grant.operationId));
      envelope.observationAttempts = purgeGrantObservations([...envelope.observationAttempts,
        ...envelope.plans.filter(plan => !grantedIds.has(plan.operationId)).map(plan => ({ operationId: plan.operationId }))]);
    }
    if (purgeCacheOverflow(envelope.plans, envelope.grants, envelope.observationAttempts, envelope.batchOperations)) purgeCacheBlocked = true;
    if (!purgeCacheBlocked && (legacyArray || legacyEncoded !== null)) {
      try {
        if (envelope.plans.length) writePurgeEnvelope(envelope);
        else { storage.removeItem(purgeGrantKey); storage.removeItem(purgeKey); }
      } catch { /* Return the readable legacy snapshot even when migration cannot be saved. */ }
    }
    return envelope;
  };
  const save = (plans: readonly PendingPlan[]) => {
    if (plans.length) storage.setItem(key, JSON.stringify(plans)); else storage.removeItem(key);
    // Failed migration must keep the only copy of a legacy query identity.
    storage.removeItem(legacyKey);
  };
  const savePurge = (plans: readonly PurgePlan[], batchOperationIds: readonly string[] = []) => {
    assertPurgeCacheWritable(plans, batchOperationIds);
    const snapshots = purgePlans(plans);
    const batchOperations = purgeBatchOperations(batchOperationIds);
    assertPurgeCacheWritable(snapshots, batchOperations);
    if (!snapshots.length) {
      // Remove legacy first so a failed clear leaves the primary guard intact.
      storage.removeItem(purgeGrantKey); storage.removeItem(purgeKey); return;
    }
    const current = readPurgeEnvelope();
    assertPurgeCacheWritable(current.plans, current.grants, current.observationAttempts, current.batchOperations);
    const activeIds = new Set(snapshots.map(plan => plan.operationId));
    writePurgeEnvelope({ schemaVersion: 1, plans: snapshots,
      grants: current.grants.filter(grant => activeIds.has(grant.operationId)),
      observationAttempts: current.observationAttempts.filter(observation => activeIds.has(observation.operationId)),
      batchOperations: batchOperations.filter(operationId => activeIds.has(operationId)) });
  };
  return {
    load: () => {
      const plans = pendingPlans([...parse(storage.getItem(key)), ...parse(storage.getItem(legacyKey))]);
      try { save(plans); } catch { /* Keep the legacy cache and query from memory. */ }
      return plans;
    },
    save,
    loadPurge: () => readPurgeEnvelope().plans,
    savePurge,
    loadPurgeGrants: () => readPurgeEnvelope().grants,
    savePurgeGrants: grants => {
      assertPurgeCacheWritable(grants);
      const current = readPurgeEnvelope();
      assertPurgeCacheWritable(current.plans, current.grants, current.observationAttempts, current.batchOperations);
      const activeIds = new Set(current.plans.map(plan => plan.operationId));
      writePurgeEnvelope({ ...current, grants: purgeGrantSnapshots(grants).filter(grant => activeIds.has(grant.operationId)) });
    },
    loadPurgeGrantObservations: () => readPurgeEnvelope().observationAttempts,
    stagePurgeGrantObservation: operationId => {
      if (typeof operationId !== 'string' || operationId.length === 0 || operationId.length > 1024) throw new Error('Invalid operation identity.');
      const current = readPurgeEnvelope();
      assertPurgeCacheWritable(current.plans, current.grants, current.observationAttempts, current.batchOperations);
      if (!current.plans.some(plan => plan.operationId === operationId)) throw new Error('Cannot stage an observation without its pending plan.');
      writePurgeEnvelope({ ...current, observationAttempts: purgeGrantObservations([...current.observationAttempts, { operationId }]) });
    },
    loadPurgeBatchOperations: () => readPurgeEnvelope().batchOperations,
    isPurgeCacheBlocked: () => { readPurgeEnvelope(); return purgeCacheBlocked; },
  };
}

/** Browser profile/Host-wide presentation preference; independent of deletion journals. */
export function browserDeletionPreferences(storage: Pick<Storage, 'getItem' | 'setItem'>,
  events?: Pick<Window, 'addEventListener' | 'removeEventListener'>): DeletionPreferences {
  const key = 'dsh-session-bin.preferences.v1';
  const parse = (raw: string | null): boolean => {
    try { const value = JSON.parse(raw ?? 'null'); return !(value?.schemaVersion === 1 && value.confirmDeletion === false); }
    catch { return true; }
  };
  return {
    load: () => parse(storage.getItem(key)),
    save: confirmDeletion => storage.setItem(key, JSON.stringify({ schemaVersion: 1, confirmDeletion })),
    subscribe: listener => {
      const changed = (event: Event) => {
        const update = event as StorageEvent;
        if (update.storageArea === storage && (update.key === key || update.key === null)) listener(parse(update.newValue));
      };
      events?.addEventListener('storage', changed);
      return () => events?.removeEventListener('storage', changed);
    },
  };
}
