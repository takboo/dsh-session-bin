import { randomUUID } from 'node:crypto';
import { entrySchema, planSchema, prepareRequestSchema, resultSchema } from '../operations/schema.js';
import type { BinBlocker, BinEntry, BinOperation, BinPlan, BinResult, PrepareRequest } from '../operations/schema.js';
import type { BinStore } from './store.js';
import { SessionBinPurgeModule } from './retirement.js';
import type { RetirementOptions } from './retirement.js';
import { preparePurgeRequestSchema, purgePlanSchema } from '../operations/retirement.js';
import type { PreparePurgeRequest, PurgePlan } from '../operations/retirement.js';

export class SessionBinError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionBinError';
  }
}
export interface NativeSessionState {
  archived: boolean;
  known: boolean;
  workspaceId: string | null;
}
export interface NativeBinPort {
  inspect(sessionId: string): Promise<NativeSessionState>;
  activity(sessionId: string): Promise<string[]>;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
}
export interface ReconcileReport {
  completed: BinResult[];
  retryRequired: string[];
  releasedEntries: string[];
}

/** One Host owns this Module; its caller holds the lifetime lease before open. */
export class SessionBinModule {
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private failure: unknown;
  private closePromise: Promise<void> | undefined;
  private readonly invalidated = new Set<string>();
  private readonly observedArchived = new Set<string>();
  private readonly purge: SessionBinPurgeModule | undefined;

  constructor(private readonly store: BinStore, private readonly native: NativeBinPort,
    options: { retirement?: RetirementOptions } = {}) {
    this.purge = options.retirement ? new SessionBinPurgeModule(options.retirement, {
      entry: id => this.store.entry(id), invalidated: id => this.invalidated.has(id),
      archived: async id => (await this.native.inspect(id)).archived,
      activity: id => this.native.activity(id), deleteEntry: id => this.store.deleteEntry(id),
      hasArchiveOperation: id => this.store.operation(id) !== undefined,
      hasPendingArchiveOperation: id => this.store.operations().some(item => item.phase !== 'done' && item.plan.sessionId === id),
    }) : undefined;
  }

  preparePurge(request: PreparePurgeRequest) {
    const input = preparePurgeRequestSchema.parse(request);
    return this.enqueue(async () => {
      await this.reconcileInner();
      return this.requirePurge().prepare(input);
    });
  }
  executePurge(input: PurgePlan) {
    const plan = purgePlanSchema.parse(input);
    return this.enqueue(() => this.requirePurge().execute(plan));
  }
  getPurgeOperation(operationId: string) { return this.enqueue(async () => this.requirePurge().operation(operationId)); }
  purgeOperations() { return this.enqueue(async () => this.requirePurge().operations()); }
  reconcilePurge() { return this.enqueue(() => this.requirePurge().reconcile(true)); }
  private requirePurge(): SessionBinPurgeModule {
    if (!this.purge) throw new SessionBinError('bin/permanent-deletion-unsupported', 'No retirement journal/owner is composed.');
    return this.purge;
  }

  prepare(request: PrepareRequest): Promise<BinPlan> {
    const input = prepareRequestSchema.parse(request);
    return this.enqueue(async () => {
      await this.reconcileInner();
      const state = await this.native.inspect(input.sessionId);
      const entry = this.store.entry(input.sessionId);
      const plan: BinPlan = {
        schemaVersion: 1,
        operationId: input.operationId ?? randomUUID(),
        action: input.action,
        sessionId: input.sessionId,
        expected: { archived: state.archived, entryId: entry?.entryId ?? null },
        blockers: [],
      };
      plan.blockers = await this.blockers(plan, state, entry);
      return planSchema.parse(plan);
    });
  }

  execute(input: BinPlan): Promise<BinResult> {
    // Snapshot at admission: callers cannot mutate an enqueued request.
    const plan = planSchema.parse(input);
    return this.enqueue(async () => {
      if (this.purge?.operation(plan.operationId)) {
        throw new SessionBinError('bin/operation-id-reused', 'Operation identity belongs to a purge request.');
      }
      const previous = this.store.operation(plan.operationId);
      if (previous) {
        if (!this.sameRequest(previous.plan, plan)) {
          throw new SessionBinError('bin/operation-id-reused', 'Operation identity belongs to a different request.');
        }
        if (previous.result) return resultSchema.parse(previous.result);
        if (previous.phase === 'applied') return this.finalize(previous);
      }
      await this.reconcileInner();
      const recovered = this.store.operation(plan.operationId);
      if (recovered?.result) return resultSchema.parse(recovered.result);
      const state = await this.native.inspect(plan.sessionId);
      const current = this.store.entry(plan.sessionId);
      const stale = state.archived !== plan.expected.archived
        || (current?.entryId ?? null) !== plan.expected.entryId
        || (recovered?.entry && this.invalidated.has(recovered.entry.entryId));
      if (stale) return this.finish(recovered ?? this.emptyOperation(plan), 'conflict', 'state-changed');
      const blockers = await this.blockers(plan, state, current);
      if (blockers.length) return this.finish(recovered ?? this.emptyOperation(plan), 'rejected', blockers[0]!.code);
      const entry = recovered?.entry ?? (plan.action === 'bin' ? entrySchema.parse({
        schemaVersion: 1,
        sessionId: plan.sessionId,
        entryId: randomUUID(),
        operationId: plan.operationId,
        binnedAt: new Date().toISOString(),
        workspaceIdAtBin: state.workspaceId,
        wasArchived: state.archived,
      }) : current!);
      const operation: BinOperation = recovered ?? {
        ...this.emptyOperation(plan), entry, phase: 'intent',
      };
      if (plan.action === 'bin' && !recovered) await this.purge?.capture(entry);
      await this.store.putOperation(operation);
      // The intent write itself yields. Check native state and activity again;
      // ordinary native archive still performs its own admission waterfall.
      const fresh = await this.native.inspect(plan.sessionId);
      if (fresh.archived !== plan.expected.archived || this.invalidated.has(entry.entryId)) {
        return this.finish(operation, 'conflict', 'state-changed');
      }
      if (!fresh.known) return this.finish(operation, 'rejected', 'session-not-found');
      try {
        if (plan.action === 'bin') {
          if ((await this.native.activity(plan.sessionId)).length) {
            return this.finish(operation, 'rejected', 'session-active');
          }
          const admitted = await this.native.inspect(plan.sessionId);
          if (admitted.archived !== plan.expected.archived || this.invalidated.has(entry.entryId)) {
            return this.finish(operation, 'conflict', 'state-changed');
          }
          if (!admitted.known) return this.finish(operation, 'rejected', 'session-not-found');
          await this.native.archive(plan.sessionId);
        } else if (!entry.wasArchived) {
          await this.native.unarchive(plan.sessionId);
        }
      } catch (error) {
        if (error instanceof SessionBinError
          && (error.code === 'session-active' || error.code === 'session-not-found')) {
          return this.finish(operation, 'rejected', error.code);
        }
        throw error;
      }
      const applied: BinOperation = { ...operation, phase: 'applied' };
      await this.store.putOperation(applied);
      return this.finalize(applied);
    });
  }

  list(): Promise<BinEntry[]> {
    return this.enqueue(async () => {
      await this.reconcileInner();
      return this.store.entries();
    });
  }
  operations(): Promise<BinOperation[]> {
    return this.enqueue(async () => {
      await this.reconcileInner();
      return this.store.operations();
    });
  }
  getOperation(operationId: string): Promise<BinOperation | undefined> {
    return this.enqueue(async () => this.store.operation(operationId));
  }
  reconcile(): Promise<ReconcileReport> {
    return this.enqueue(async () => {
      await this.purge?.reconcile(true);
      return this.reconcileInner();
    });
  }

  /** Capture each native archive frame NOW, before queued reconciliation yields.
   * An observed unarchive/rearchive must not restore an old entry's ownership.
   * No archive-generation token exists in the SDK for an unobserved restart ABA.
   */
  observeArchives(archivedSessionIds: readonly string[]): Promise<ReconcileReport> {
    if (this.failure) return Promise.reject(this.unavailable());
    const archived = new Set(archivedSessionIds);
    for (const entry of this.store.entries()) {
      if (!archived.has(entry.sessionId)) this.invalidated.add(entry.entryId);
    }
    for (const operation of this.store.operations()) {
      const entry = operation.entry;
      if (operation.phase === 'done' || !entry) continue;
      if (archived.has(entry.sessionId)) this.observedArchived.add(entry.entryId);
      else if (operation.phase === 'applied' || entry.wasArchived
        || this.observedArchived.has(entry.entryId)) this.invalidated.add(entry.entryId);
    }
    return this.closing
      ? Promise.resolve({ completed: [], retryRequired: [], releasedEntries: [] })
      : this.enqueue(() => this.reconcileInner());
  }

  close(): Promise<void> {
    this.closing = true;
    return this.closePromise ??= this.tail.then(async () => {
      try {
        if (!this.failure) await this.reconcileInner();
      } finally {
        try { await this.purge?.close(); }
        finally { await this.store.close(); }
      }
    });
  }

  private emptyOperation(plan: BinPlan): BinOperation {
    return { schemaVersion: 1, plan, createdAt: new Date().toISOString(), phase: 'done', ownershipInvalidated: false, entry: null, result: null };
  }
  private sameRequest(a: BinPlan, b: BinPlan): boolean {
    return a.action === b.action && a.sessionId === b.sessionId
      && a.expected.archived === b.expected.archived && a.expected.entryId === b.expected.entryId;
  }
  private async blockers(plan: BinPlan, state: NativeSessionState, entry: BinEntry | undefined): Promise<BinBlocker[]> {
    const blockers: BinBlocker[] = [];
    if (this.purge?.blocks(plan.sessionId)) blockers.push({ code: 'pending-deletion' });
    if (!state.known) blockers.push({ code: 'session-not-found' });
    if (plan.action === 'bin' && entry) blockers.push({ code: 'already-in-bin' });
    if (plan.action === 'restore' && !entry) blockers.push({ code: 'not-in-bin' });
    if (this.store.operations().some(operation => operation.phase !== 'done'
      && operation.plan.sessionId === plan.sessionId && operation.plan.operationId !== plan.operationId)) {
      blockers.push({ code: 'pending-operation' });
    }
    if (plan.action === 'bin' && state.known) {
      const activity = await this.native.activity(plan.sessionId);
      if (activity.length) blockers.push({ code: 'session-active', activity });
    }
    return blockers;
  }
  private async finish(operation: BinOperation, status: BinResult['status'], reason: string | null): Promise<BinResult> {
    const result = resultSchema.parse({
      operationId: operation.plan.operationId,
      action: operation.plan.action,
      sessionId: operation.plan.sessionId,
      status, reason, entryId: operation.entry?.entryId ?? null,
    });
    const ownershipInvalidated = operation.ownershipInvalidated
      || (operation.entry !== null && this.invalidated.has(operation.entry.entryId))
      || reason === 'archive-changed';
    await this.store.putOperation({ ...operation, phase: 'done', ownershipInvalidated, result });
    return resultSchema.parse(result);
  }
  private async finalize(operation: BinOperation): Promise<BinResult> {
    const entry = operation.entry!;
    const state = await this.native.inspect(operation.plan.sessionId);
    const targetArchived = operation.plan.action === 'bin' || entry.wasArchived;
    const lost = this.invalidated.has(entry.entryId)
      && (operation.plan.action === 'bin' || entry.wasArchived);
    if (state.archived !== targetArchived || lost) {
      return this.finish(operation, 'conflict', 'archive-changed');
    }
    if (!state.known) return this.finish(operation, 'conflict', 'session-not-found');
    if (operation.plan.action === 'bin' && this.purge && !(await this.purge.bindingMatches(entry))) {
      return this.finish(operation, 'conflict', 'lifecycle-changed');
    }
    const current = this.store.entry(entry.sessionId);
    if (current && current.entryId !== entry.entryId) {
      return this.finish(operation, 'conflict', 'entry-changed');
    }
    if (operation.plan.action === 'bin') {
      if (!current) await this.store.putEntry(entry);
      if (this.invalidated.has(entry.entryId)) {
        const result = await this.finish(operation, 'conflict', 'archive-changed');
        await this.store.deleteEntry(entry.sessionId);
        return result;
      }
    } else if (current) {
      await this.store.deleteEntry(entry.sessionId);
    }
    return this.finish(operation, 'success', null);
  }
  private async reconcileInner(): Promise<ReconcileReport> {
    const report: ReconcileReport = { completed: [], retryRequired: [], releasedEntries: [] };
    await this.purge?.reconcile();
    for (const operation of this.store.operations()) {
      if (operation.ownershipInvalidated && operation.entry) this.invalidated.add(operation.entry.entryId);
    }
    for (const operation of this.store.operations()) {
      if (operation.phase === 'done') continue;
      if (operation.phase === 'applied') {
        report.completed.push(await this.finalize(operation));
        continue;
      }
      // Equal before/after booleans cannot prove whether a native call ran and
      // was then undone. Retain a terminal receipt; a NEW explicit plan is needed.
      report.completed.push(await this.finish(operation, 'conflict', 'interrupted'));
      report.retryRequired.push(operation.plan.operationId);
    }
    for (const entry of this.store.entries()) {
      if (this.purge?.ownsPendingEntry(entry.entryId)) continue;
      if (this.invalidated.has(entry.entryId) || !(await this.native.inspect(entry.sessionId)).archived) {
        const owner = this.store.operation(entry.operationId);
        if (!owner || owner.entry?.entryId !== entry.entryId) {
          throw new Error('Bin entry has no matching ownership journal.');
        }
        if (!owner.ownershipInvalidated) {
          await this.store.putOperation({ ...owner, ownershipInvalidated: true });
        }
        await this.store.deleteEntry(entry.sessionId);
        report.releasedEntries.push(entry.sessionId);
      }
    }
    return report;
  }
  private unavailable(): SessionBinError {
    return new SessionBinError(this.failure ? 'bin/recovery-required' : 'bin/closed',
      this.failure ? 'An unexpected failure suspended this Module. Close and reopen before retrying.' : 'Session Bin is closing.',
      this.failure ? { cause: this.failure } : undefined);
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing || this.failure) return Promise.reject(this.unavailable());
    const result = this.tail.then(async () => {
      if (this.failure) throw this.unavailable();
      try { return await work(); }
      catch (error) {
        // An I/O rejection may follow a durable rename. Do not keep writing from
        // an in-memory snapshot that could now differ from the backend medium.
        if (!(error instanceof SessionBinError)) this.failure = error;
        throw error;
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
