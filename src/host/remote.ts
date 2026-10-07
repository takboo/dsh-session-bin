import { Context } from '@deepseek-ai/cordis';
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { RemoteStream } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '../index.js';
import { SessionBinError } from './module.js';
import { entriesSchema, optionalOperationSchema, sessionBinHostContribution, sessionBinRemoteNamespace,
  sessionBinRemoteServiceKey, snapshotSchema, binRemoteErrorCodes } from '../remote/contracts.js';
import type { BinRemoteErrorCode, BinSnapshot } from '../remote/contracts.js';
import { archivePlanSchema as planSchema, archiveResultSchema as resultSchema } from '../operations/archive.js';
import type { ArchiveOperation, ArchivePlan as BinPlan, ArchiveResult as BinResult, ArchivePrepareRequest as PrepareRequest } from '../operations/archive.js';
import type { BinOperation } from '../operations/schema.js';

const knownRemoteCodes = new Set<string>(binRemoteErrorCodes);
function isBinRemoteCode(code: string): code is BinRemoteErrorCode { return knownRemoteCodes.has(code); }
function wakeGate(): { promise: Promise<void>; resolve: () => void } {
  let finish!: () => void;
  const promise = new Promise<void>(resolve => { finish = resolve; });
  return { promise, resolve: finish };
}

/** Public strict Typert adapter; all native mutation stays in the existing Module. */
export class SessionBinRemote extends TypertRemoteService {
  static inject = ['sessionBin', 'typert'];
  private readonly lifetime = new AbortController();
  private readonly streams = new Set<AsyncIterableIterator<BinSnapshot>>();
  private closed = false;

  constructor(ctx: Context) {
    super(ctx, sessionBinRemoteServiceKey, { namespace: sessionBinRemoteNamespace });
    ctx.typert.register(sessionBinHostContribution);
    ctx.effect(() => async () => {
      this.closed = true;
      this.lifetime.abort();
      const streams = [...this.streams];
      this.streams.clear();
      // Await generator cleanup even when a consumer paused after a snapshot.
      await Promise.allSettled(streams.map(stream => stream.return?.()));
    }, 'session-bin.remote.dispose');
  }

  prepare(request: PrepareRequest, signal: AbortSignal): Promise<BinPlan> {
    return this.call(signal, async () => planSchema.parse(await this.ctx.sessionBin.prepare(request)));
  }
  execute(plan: BinPlan, signal: AbortSignal): Promise<BinResult> {
    // Cancellation fences admission. An accepted operation is awaited through
    // durability, so a dropped reply can be recovered by its operation identity.
    return this.call(signal, async () => resultSchema.parse(await this.ctx.sessionBin.execute(plan)));
  }
  list(signal: AbortSignal) {
    return this.call(signal, async () => entriesSchema.parse(await this.ctx.sessionBin.list()));
  }
  getOperation(operationId: string, signal: AbortSignal): Promise<ArchiveOperation | BinOperation | null> {
    return this.call(signal, async () => optionalOperationSchema.parse(await this.ctx.sessionBin.getOperation(operationId) ?? null));
  }

  follow(signal: AbortSignal): RemoteStream<BinSnapshot> {
    const cancelled = new AbortController();
    const lifetime = AbortSignal.any([signal, this.lifetime.signal, cancelled.signal]);
    const source = this.snapshots(lifetime);
    const streams = this.streams;
    const iterator: AsyncIterableIterator<BinSnapshot> = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        try {
          const next = await source.next();
          if (next.done) streams.delete(iterator);
          return next;
        } catch (error) { streams.delete(iterator); throw error; }
      },
      async return() {
        cancelled.abort();
        streams.delete(iterator);
        return source.return();
      },
      async throw(error: unknown) {
        cancelled.abort(error);
        streams.delete(iterator);
        return source.throw(error);
      },
    };
    streams.add(iterator);
    return iterator;
  }

  private async *snapshots(signal: AbortSignal): AsyncGenerator<BinSnapshot, void, unknown> {
    if (signal.aborted || this.closed) return;
    let dirty = true;
    let wake = wakeGate();
    const changed = () => { dirty = true; wake.resolve(); };
    // Subscribe before the first list. Every generation receives a full baseline;
    // notifications are coalesced into replacement snapshots, with no replay cursor.
    const off = this.ctx.root.on('domain/changed', change => {
      if (change.domain === 'session_archive' || change.domain === 'workspace') changed();
    });
    signal.addEventListener('abort', changed, { once: true });
    let previous: string | undefined;
    try {
      while (!signal.aborted && !this.closed) {
        if (dirty) {
          dirty = false;
          const snapshot = await this.call(signal, async () => snapshotSchema.parse({
            schemaVersion: 2, entries: await this.ctx.sessionBin.list(),
          }));
          if (signal.aborted || this.closed) return;
          const signature = JSON.stringify(snapshot);
          if (signature !== previous) {
            previous = signature;
            yield snapshot;
          }
          continue;
        }
        await wake.promise;
        wake = wakeGate();
      }
    } finally {
      off();
      signal.removeEventListener('abort', changed);
    }
  }

  private async call<Result>(signal: AbortSignal, operation: () => Promise<Result>): Promise<Result> {
    if (this.closed) throw new RemoteError('bin/closed', 'Session Bin Remote is unloading.', {});
    signal.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      if (error instanceof SessionBinError && isBinRemoteCode(error.code)) {
        throw new RemoteError(error.code, error.message, {}, { cause: error });
      }
      throw error;
    }
  }
}

/** The parent Host calls this only after its SessionBin Module has initialized. */
export async function installSessionBinRemote(ctx: Context): Promise<() => Promise<void>> {
  const fiber = ctx.plugin(SessionBinRemote);
  try { await fiber; }
  catch (error) { await fiber.dispose(); throw error; }
  return async () => { await fiber.dispose(); };
}
