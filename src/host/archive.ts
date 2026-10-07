import { randomUUID } from 'node:crypto';
import { archiveEntrySchema, archivePlanSchema, archivePrepareRequestSchema, archiveResultSchema } from '../operations/archive.js';
import type { ArchiveEntry, ArchiveOperation, ArchivePlan, ArchivePrepareRequest, ArchiveResult } from '../operations/archive.js';
import type { BinBlocker } from '../operations/schema.js';
import type { ArchiveStore } from './store.js';
import { SessionBinError, sessionBinRefusal, isSessionBinRefusal } from './module.js';
import type { NativeSessionState } from './module.js';

export interface NativeArchivePort {
  archivedSessionIds(): readonly string[];
  inspect(sessionId: string): Promise<NativeSessionState>;
  unarchive(sessionId: string): Promise<void>;
}
export interface ArchiveOptions {
  operationIdClaimed?: (operationId: string) => boolean;
  pendingPurge?: (sessionId: string) => boolean;
  reconcileLegacy?: () => Promise<unknown>;
}

/** Native archive membership, with durable observation identities, never deletion grants. */
export class ArchiveModule {
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private failed = false;
  private failure: unknown;
  private closePromise: Promise<void> | undefined;
  private readonly invalidated = new Set<string>();
  private readonly rearchived = new Set<string>();
  // Track allocated identities before put settles so a frame cannot miss them.
  private readonly identities = new Map<string, ArchiveEntry>();
  constructor(private readonly store: ArchiveStore, private readonly native: NativeArchivePort,
    private readonly options: ArchiveOptions = {}) {
    for (const entry of store.entries()) this.identities.set(entry.entryId, entry);
    for (const operation of store.operations()) {
      this.checkClaim(operation.plan.operationId);
      if (operation.phase !== 'done' && operation.entry) this.identities.set(operation.entry.entryId, operation.entry);
    }
  }

  prepare(request: ArchivePrepareRequest): Promise<ArchivePlan> {
    const input = archivePrepareRequestSchema.parse(request);
    return this.enqueue(async () => {
      await this.reconcileInner();
      const state = await this.native.inspect(input.sessionId);
      await this.syncEntries();
      const entry = this.store.entry(input.sessionId);
      const plan: ArchivePlan = {
        schemaVersion: 2, operationId: input.operationId ?? randomUUID(), action: 'unarchive', sessionId: input.sessionId,
        expected: { archived: state.archived, entryId: entry?.entryId ?? null }, blockers: [],
      };
      this.checkClaim(plan.operationId);
      plan.blockers = this.blockers(plan, state, entry);
      return archivePlanSchema.parse(plan);
    });
  }

  execute(input: ArchivePlan): Promise<ArchiveResult> {
    const plan = archivePlanSchema.parse(input);
    return this.enqueue(async () => {
      this.checkClaim(plan.operationId);
      const previous = this.store.operation(plan.operationId);
      if (previous && !this.sameRequest(previous.plan, plan)) {
        throw sessionBinRefusal('bin/operation-id-reused', 'Operation identity belongs to a different request.');
      }
      if (previous?.result) return archiveResultSchema.parse(previous.result);
      await this.reconcileInner();
      const recovered = this.store.operation(plan.operationId);
      if (recovered?.result) return archiveResultSchema.parse(recovered.result);
      const state = await this.native.inspect(plan.sessionId);
      await this.syncEntries();
      const entry = this.store.entry(plan.sessionId);
      const operation: ArchiveOperation = {
        schemaVersion: 2, plan, createdAt: new Date().toISOString(), phase: 'done',
        entry: entry?.entryId === plan.expected.entryId ? entry : null, result: null,
      };
      if (this.stale(plan, state, entry)) return this.finish(operation, 'conflict', 'state-changed');
      const blockers = this.blockers(plan, state, entry);
      if (blockers.length) return this.finish(operation, 'rejected', blockers[0]!.code);
      const intent: ArchiveOperation = { ...operation, phase: 'intent' };
      await this.store.putOperation(intent);
      // The intent and existence inspection yield. Capture invalidation outside
      // this queue, then inspect the current member/identity immediately at admission.
      const fresh = await this.native.inspect(plan.sessionId);
      if (this.stale(plan, fresh, this.store.entry(plan.sessionId))) return this.finish(intent, 'conflict', 'state-changed');
      const freshBlockers = this.blockers(plan, fresh, this.store.entry(plan.sessionId));
      if (freshBlockers.length) return this.finish(intent, 'rejected', freshBlockers[0]!.code);
      await this.native.unarchive(plan.sessionId);
      const applied: ArchiveOperation = { ...intent, phase: 'applied' };
      await this.store.putOperation(applied);
      return this.finalize(applied);
    });
  }

  compatibility<T>(work: () => Promise<T>): Promise<T> { return this.enqueue(work); }
  list(): Promise<ArchiveEntry[]> {
    return this.enqueue(async () => { await this.reconcileInner(); return this.store.entries(); });
  }
  getOperation(operationId: string): Promise<ArchiveOperation | undefined> {
    return this.enqueue(async () => this.store.operation(operationId));
  }
  operations(): Promise<ArchiveOperation[]> {
    return this.enqueue(async () => { await this.reconcileInner(); return this.store.operations(); });
  }
  reconcile(): Promise<void> { return this.enqueue(() => this.reconcileInner()); }
  observeArchives(ids: readonly string[]): Promise<void> {
    if (this.failed) return Promise.reject(this.unavailable());
    const members = new Set(ids);
    for (const entry of this.identities.values()) {
      if (!members.has(entry.sessionId)) this.invalidated.add(entry.entryId);
      else if (this.invalidated.has(entry.entryId)) this.rearchived.add(entry.entryId);
    }
    return this.closing ? Promise.resolve() : this.enqueue(() => this.reconcileInner());
  }
  close(): Promise<void> {
    this.closing = true;
    return this.closePromise ??= this.tail.then(async () => {
      try { if (!this.failed) await this.reconcileInner(); }
      finally { await this.store.close(); }
    });
  }

  private checkClaim(operationId: string) {
    if (this.options.operationIdClaimed?.(operationId)) {
      throw sessionBinRefusal('bin/operation-id-reused', 'Operation identity belongs to a legacy or purge request.');
    }
  }
  private sameRequest(a: ArchivePlan, b: ArchivePlan) {
    return a.sessionId === b.sessionId && a.action === b.action
      && a.expected.archived === b.expected.archived && a.expected.entryId === b.expected.entryId;
  }
  private stale(plan: ArchivePlan, state: NativeSessionState, entry: ArchiveEntry | undefined) {
    return state.archived !== plan.expected.archived
      || this.native.archivedSessionIds().includes(plan.sessionId) !== plan.expected.archived
      || (entry?.entryId ?? null) !== plan.expected.entryId
      || (entry !== undefined && this.invalidated.has(entry.entryId));
  }
  private blockers(plan: ArchivePlan, state: NativeSessionState, entry: ArchiveEntry | undefined): BinBlocker[] {
    const blockers: BinBlocker[] = [];
    if (this.options.pendingPurge?.(plan.sessionId)) blockers.push({ code: 'pending-deletion' });
    if (!state.known) blockers.push({ code: 'session-not-found' });
    if (!state.archived || !entry || this.invalidated.has(entry.entryId)) blockers.push({ code: 'not-archived' });
    if (this.store.operations().some(item => item.phase !== 'done' && item.plan.sessionId === plan.sessionId
      && item.plan.operationId !== plan.operationId)) blockers.push({ code: 'pending-operation' });
    return blockers;
  }
  private async finish(operation: ArchiveOperation, status: ArchiveResult['status'], reason: string | null) {
    const result = archiveResultSchema.parse({ operationId: operation.plan.operationId, action: 'unarchive',
      sessionId: operation.plan.sessionId, status, reason, entryId: operation.entry?.entryId ?? null });
    await this.store.putOperation({ ...operation, phase: 'done', result });
    return archiveResultSchema.parse(result);
  }
  private async finalize(operation: ArchiveOperation) {
    const state = await this.native.inspect(operation.plan.sessionId);
    if (state.archived || this.native.archivedSessionIds().includes(operation.plan.sessionId)
      || (operation.entry && this.rearchived.has(operation.entry.entryId))) {
      return this.finish(operation, 'conflict', 'archive-changed');
    }
    if (!state.known) return this.finish(operation, 'conflict', 'session-not-found');
    const current = this.store.entry(operation.plan.sessionId);
    if (current && current.entryId !== operation.entry?.entryId) return this.finish(operation, 'conflict', 'entry-changed');
    if (current) await this.store.deleteEntry(current.sessionId);
    return this.finish(operation, 'success', null);
  }
  private async reconcileInner(): Promise<void> {
    await this.options.reconcileLegacy?.();
    for (const operation of this.store.operations()) {
      if (operation.phase === 'done') continue;
      if (operation.phase === 'applied') await this.finalize(operation);
      else await this.finish(operation, 'conflict', 'interrupted');
    }
    await this.syncEntries();
  }
  private async syncEntries(): Promise<void> {
    // Re-read after every yielded write. A list is a complete current native
    // set even when another archive/unarchive happens during a slow sidecar put.
    while (true) {
      const before = new Set(this.native.archivedSessionIds());
      for (const entry of this.store.entries()) {
        if (this.invalidated.has(entry.entryId) || !before.has(entry.sessionId)) {
          await this.store.deleteEntry(entry.sessionId);
        }
      }
      for (const sessionId of this.native.archivedSessionIds()) {
        const current = this.store.entry(sessionId);
        if (!current || this.invalidated.has(current.entryId)) {
          const entry = archiveEntrySchema.parse({ schemaVersion: 2, sessionId, entryId: randomUUID() });
          this.identities.set(entry.entryId, entry);
          await this.store.putEntry(entry);
        }
      }
      const members = new Set(this.native.archivedSessionIds());
      const entries = this.store.entries();
      if (entries.length === members.size && entries.every(entry => members.has(entry.sessionId)
        && !this.invalidated.has(entry.entryId))) break;
    }
    const retained = new Set(this.store.entries().map(entry => entry.entryId));
    for (const operation of this.store.operations()) {
      if (operation.phase !== 'done' && operation.entry) retained.add(operation.entry.entryId);
    }
    for (const entryId of this.identities.keys()) {
      if (retained.has(entryId)) continue;
      this.identities.delete(entryId);
      this.invalidated.delete(entryId);
      this.rearchived.delete(entryId);
    }
  }
  private unavailable() {
    return new SessionBinError(this.failed ? 'bin/recovery-required' : 'bin/closed',
      this.failed ? 'Close and reopen the archive service after an unexpected failure.' : 'Archive service is closing.',
      this.failed ? { cause: this.failure } : undefined);
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing || this.failed) return Promise.reject(this.unavailable());
    const result = this.tail.then(async () => {
      if (this.failed) throw this.unavailable();
      try { return await work(); }
      catch (error) {
        if (!isSessionBinRefusal(error)) {
          this.failed = true; this.failure = error;
        }
        throw error;
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
