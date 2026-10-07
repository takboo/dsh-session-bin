import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client';
import { planSchema } from '../operations/schema.js';
import type { BinPlan } from '../operations/schema.js';
import { archivePlanSchema } from '../operations/archive.js';
import type { ArchiveEntry, ArchivePlan, ArchiveResult } from '../operations/archive.js';
import { snapshotSchema } from '../remote/contracts.js';
import type { SessionBinRemoteApi, BinSnapshot } from '../remote/contracts.js';

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
  kind: 'unarchived' | 'failed';
  sessionId: string;
  entryId: string | null;
  reason: string | null;
}
export interface BinClientState {
  phase: 'loading' | 'ready' | 'error';
  entries: readonly ArchiveEntry[];
  busy: readonly string[];
  pending: readonly PendingPlan[];
  results: readonly ClientOutcome[];
  error: string | null;
  notice: BinNotice | null;
}
export interface PendingCache {
  load(): unknown;
  save(plans: readonly PendingPlan[]): void;
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

/** One browser page model; native mutations only pass through the Host API. */
export class SessionBinClientModel {
  private state: BinClientState = {
    phase: 'loading', entries: [], busy: [], pending: [], results: [], error: null, notice: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private stream: RemoteStream<BinSnapshot> | undefined;
  private consumption: Promise<void> = Promise.resolve();
  private epoch = 0;
  private noticeSequence = 0;
  private readonly checking = new Set<string>();

  constructor(private readonly api: SessionBinRemoteApi,
    private readonly createStream: () => RemoteStream<BinSnapshot>, private readonly cache?: PendingCache) {
    try { this.state = { ...this.state, pending: pendingPlans(cache?.load()) }; }
    catch { /* A withheld cache does not prevent the page from connecting. */ }
  }
  getSnapshot = (): BinClientState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: Partial<BinClientState>): void {
    if (this.lifetime.signal.aborted) return;
    this.state = { ...this.state, ...next };
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
        }
      } catch {
        if (epoch === this.epoch) this.publish({ phase: 'error', error: 'connection-failed' });
      }
    })();
  }
  async dispose(): Promise<void> {
    this.lifetime.abort();
    ++this.epoch;
    await this.stream?.dispose();
    await this.consumption;
    this.listeners.clear();
  }
  dismissNotice(): void { this.publish({ notice: null }); }

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
  const parse = (item: string | null): PendingPlan[] => {
    try { return pendingPlans(JSON.parse(item ?? '[]')); } catch { return []; }
  };
  const save = (plans: readonly PendingPlan[]) => {
    if (plans.length) storage.setItem(key, JSON.stringify(plans)); else storage.removeItem(key);
    // Failed migration must keep the only copy of a legacy query identity.
    storage.removeItem(legacyKey);
  };
  return {
    load: () => {
      const plans = pendingPlans([...parse(storage.getItem(key)), ...parse(storage.getItem(legacyKey))]);
      try { save(plans); } catch { /* Keep the legacy cache and query from memory. */ }
      return plans;
    },
    save,
  };
}
