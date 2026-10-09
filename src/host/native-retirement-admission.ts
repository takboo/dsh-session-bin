import { AsyncLocalStorage } from 'node:async_hooks';

export class NativeAdmissionError extends Error { readonly code = 'native/session-busy'; }

/** Shared per-target mutation gates and global header/migration read barriers. */
export class NativeAdmission {
  private readonly maintenance = new AsyncLocalStorage<{ id: string; active: boolean } | undefined>();
  private readonly acceptedFrames = new AsyncLocalStorage<symbol>();
  private readonly activeAcceptedFrames = new Set<symbol>();
  private readonly held = new Set<string>();
  private readonly released = new Map<string, { promise: Promise<void>; resolve(): void }>();
  private readonly pending = new Map<string, Set<Promise<unknown>>>();
  private readonly globalReads = new Set<Promise<unknown>>();
  private readonly retired = new Set<string>();
  private readonly candidates = new Set<string>();
  private closing = false;
  private failed = false;
  private ready = false;

  requiresRecovery(): boolean { return this.failed; }
  activate(): void { this.ready = true; }
  suspend(): void { this.failed = true; }
  beginClose(): void { this.closing = true; }
  isRetired(id: string): boolean { return this.retired.has(id) || (this.failed && this.candidates.has(id)); }
  hasTombstones(): boolean { return this.retired.size > 0 || (this.failed && this.candidates.size > 0); }
  markRetired(id: string): void { this.retired.add(id); }
  private isAcceptedFrame(): boolean { const frame = this.acceptedFrames.getStore(); return frame !== undefined && this.activeAcceptedFrames.has(frame); }
  assertAllowed(id: string): void {
    const maintenance = this.maintenance.getStore();
    if (maintenance?.active && maintenance.id === id && !(this.failed && this.candidates.has(id))) return;
    if (!this.ready || (this.closing && !this.isAcceptedFrame()) || (this.failed && this.candidates.has(id)) || this.retired.has(id)
      || (this.held.has(id) && !this.isAcceptedFrame())) {
      throw new NativeAdmissionError('The session is reserved for retirement or awaiting recovery.');
    }
  }
  bypass<T>(id: string, work: () => T): T {
    const token = { id, active: true };
    try {
      const value = this.maintenance.run(token, work);
      if (value && typeof (value as { then?: unknown }).then === 'function') {
        return Promise.resolve(value).finally(() => { token.active = false; }) as T;
      }
      token.active = false; return value;
    } catch (error) { token.active = false; throw error; }
  }
  withoutBypass<T>(work: () => T): T { return this.maintenance.run(undefined, work); }
  track<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.assertAllowed(id);
    const tasks = this.pending.get(id) ?? new Set<Promise<unknown>>();
    this.pending.set(id, tasks);
    const frame = Symbol('native-accepted-operation');
    this.activeAcceptedFrames.add(frame);
    const task = this.acceptedFrames.run(frame, () => Promise.resolve().then(work));
    tasks.add(task);
    void task.finally(() => {
      this.activeAcceptedFrames.delete(frame);
      tasks.delete(task); if (!tasks.size) this.pending.delete(id);
    }).catch(() => {});
    return task;
  }
  async trackGlobal<T>(work: () => Promise<T>): Promise<T> {
    // Existing global reads may nest target reads; admission waits for the whole
    // accepted frame. New normal scans wait outside the drain set until release.
    if (this.closing && !this.isAcceptedFrame() && !this.maintenance.getStore()?.active) {
      throw new NativeAdmissionError('Native admission is closing.');
    }
    while (this.held.size && !this.maintenance.getStore()?.active && !this.isAcceptedFrame()) {
      await Promise.all([...this.released.values()].map(signal => signal.promise));
    }
    if (!this.ready || (this.closing && !this.isAcceptedFrame() && !this.maintenance.getStore()?.active)) {
      throw new NativeAdmissionError('Native admission is not accepting another request.');
    }
    const frame = Symbol('native-header-read');
    this.activeAcceptedFrames.add(frame);
    const task = this.acceptedFrames.run(frame, () => Promise.resolve().then(work));
    this.globalReads.add(task);
    try { return await task; }
    finally { this.activeAcceptedFrames.delete(frame); this.globalReads.delete(task); }
  }
  async drain(id?: string): Promise<void> {
    for (;;) {
      const tasks = id === undefined ? [...this.pending.values()].flatMap(set => [...set]) : [...(this.pending.get(id) ?? [])];
      tasks.push(...this.globalReads);
      if (!tasks.length) return;
      await Promise.allSettled(tasks);
    }
  }
  async acquire(id: string, recovery = false): Promise<() => void> {
    while (this.held.has(id)) await this.released.get(id)!.promise;
    if (this.failed || this.closing || !this.ready || (!recovery && this.retired.has(id))) {
      throw new NativeAdmissionError('The session cannot enter another retirement scope.');
    }
    let resolve!: () => void;
    const signal = { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
    this.held.add(id); this.released.set(id, signal); this.candidates.add(id);
    const release = () => {
      this.held.delete(id); this.released.delete(id); signal.resolve();
    };
    try { await this.drain(id); }
    catch (error) { release(); throw error; }
    let done = false;
    return () => { if (!done) { done = true; release(); } };
  }
}
