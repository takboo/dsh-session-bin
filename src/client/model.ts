import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client';
import { planSchema } from '../operations/schema.js';
import type { BinEntry, BinPlan, BinResult } from '../operations/schema.js';
import { snapshotSchema } from '../remote/contracts.js';
import type { SessionBinRemoteApi, BinSnapshot } from '../remote/contracts.js';

export interface ClientOutcome {
  sessionId: string;
  entryId: string | null;
  status: BinResult['status'] | 'pending';
  reason: string | null;
}
export interface BinNotice {
  sequence: number;
  kind: 'moved' | 'restored' | 'failed';
  sessionId: string;
  entryId: string | null;
  reason: string | null;
  wasArchived: boolean;
}
export interface BinClientState {
  phase: 'loading' | 'ready' | 'error';
  entries: readonly BinEntry[];
  busy: readonly string[];
  pending: readonly BinPlan[];
  results: readonly ClientOutcome[];
  error: string | null;
  notice: BinNotice | null;
}
export interface PendingCache {
  load(): unknown;
  save(plans: readonly BinPlan[]): void;
}
function value<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error('Session Bin Remote request failed.', { cause: result.error });
  return result.value;
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
    try {
      const raw = cache?.load();
      if (Array.isArray(raw)) this.state = { ...this.state, pending: raw.slice(0, 32).map(plan => planSchema.parse(plan)) };
    } catch { this.persist([]); }
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
  private persist(plans: readonly BinPlan[]): void {
    try { this.cache?.save(plans); } catch { /* In-memory receipts still protect this page; storage may be withheld. */ }
  }
  private pending(plans: readonly BinPlan[]): void { this.persist(plans); this.publish({ pending: plans }); }

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

  async move(sessionId: string): Promise<ClientOutcome> { return this.run('bin', sessionId); }
  async restore(entry: Pick<BinEntry, 'sessionId' | 'entryId'>): Promise<ClientOutcome> {
    return this.run('restore', entry.sessionId, entry.entryId);
  }
  async restoreMany(entries: readonly BinEntry[]): Promise<ClientOutcome[]> {
    // Freeze the click's selection. Later incoming entries never join this batch.
    const targets = entries.map(entry => ({ sessionId: entry.sessionId, entryId: entry.entryId }));
    const results: ClientOutcome[] = [];
    for (const target of targets) {
      if (this.lifetime.signal.aborted) break;
      results.push(await this.restore(target));
    }
    this.publish({ results });
    return results;
  }

  /** A connection baseline may query receipts, but never resubmit a mutation.
   * Explicit user retry can resend the SAME missing operation identity/plan.
   */
  async checkPending(retryMissing = true): Promise<void> {
    for (const plan of [...this.state.pending]) {
      if (this.checking.has(plan.operationId) || this.state.busy.includes(plan.sessionId) || this.lifetime.signal.aborted) continue;
      this.checking.add(plan.operationId);
      try {
        const operation = value(await this.api.getOperation(plan.operationId, this.lifetime.signal));
        if (operation?.result) this.settle(plan, operation.result, operation.entry?.wasArchived);
        else if (operation === null && retryMissing) {
          this.settle(plan, value(await this.api.execute(plan, this.lifetime.signal)));
        }
      } catch { this.publish({ error: 'pending-result' }); }
      finally { this.checking.delete(plan.operationId); }
    }
  }
  private settle(plan: BinPlan, result: BinResult, wasArchived?: boolean): ClientOutcome {
    const outcome: ClientOutcome = {
      sessionId: result.sessionId, entryId: result.entryId, status: result.status, reason: result.reason,
    };
    const entry = this.state.entries.find(row => row.entryId === result.entryId);
    this.pending(this.state.pending.filter(row => row.operationId !== plan.operationId));
    this.publish({
      results: [outcome],
      error: this.state.pending.length ? 'pending-result' : null,
      notice: {
        sequence: ++this.noticeSequence,
        kind: result.status === 'success' ? (plan.action === 'bin' ? 'moved' : 'restored') : 'failed',
        sessionId: result.sessionId, entryId: result.entryId, reason: result.reason,
        wasArchived: wasArchived ?? entry?.wasArchived ?? (plan.action === 'bin' && plan.expected.archived),
      },
    });
    return outcome;
  }
  private async run(action: 'bin' | 'restore', sessionId: string, expectedEntryId?: string): Promise<ClientOutcome> {
    if (this.state.phase !== 'ready' || this.state.busy.includes(sessionId)
      || this.state.pending.some(plan => plan.sessionId === sessionId) || this.lifetime.signal.aborted) {
      return { sessionId, entryId: expectedEntryId ?? null, status: 'pending', reason: 'pending-result' };
    }
    this.publish({ busy: [...this.state.busy, sessionId], error: null });
    let plan: BinPlan | undefined;
    const wasArchived = this.state.entries.find(entry => entry.entryId === expectedEntryId)?.wasArchived;
    try {
      plan = value(await this.api.prepare({ action, sessionId, operationId: crypto.randomUUID() }, this.lifetime.signal));
      if (expectedEntryId && plan.expected.entryId !== expectedEntryId) {
        const result: BinResult = { operationId: plan.operationId, action, sessionId, entryId: expectedEntryId,
          status: 'conflict', reason: 'entry-changed' };
        return this.settle(plan, result);
      }
      this.pending([...this.state.pending, plan]);
      return this.settle(plan, value(await this.api.execute(plan, this.lifetime.signal)), wasArchived);
    } catch {
      if (plan) {
        try {
          const operation = value(await this.api.getOperation(plan.operationId, this.lifetime.signal));
          if (operation?.result) return this.settle(plan, operation.result, operation.entry?.wasArchived);
        } catch { /* Preserve the saved plan until a confirmed receipt arrives. */ }
      }
      const outcome: ClientOutcome = { sessionId, entryId: expectedEntryId ?? null,
        status: plan ? 'pending' : 'rejected', reason: plan ? 'pending-result' : 'connection-failed' };
      this.publish({ error: outcome.reason, results: [outcome], notice: {
        sequence: ++this.noticeSequence, kind: 'failed', sessionId, entryId: outcome.entryId,
        reason: outcome.reason, wasArchived: false,
      } });
      return outcome;
    } finally { this.publish({ busy: this.state.busy.filter(id => id !== sessionId) }); }
  }
}

export function browserPendingCache(storage: Storage): PendingCache {
  const key = 'dsh-session-bin.pending.v1';
  return {
    load: () => JSON.parse(storage.getItem(key) ?? '[]'),
    save: plans => { if (plans.length) storage.setItem(key, JSON.stringify(plans)); else storage.removeItem(key); },
  };
}
