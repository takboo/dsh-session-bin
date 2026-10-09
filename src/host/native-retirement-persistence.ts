import type { SessionHeader } from '@deepseek-ai/dsh-session';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionHandle, SessionPersistence, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';
import { NativeAdmission, NativeAdmissionError } from './native-retirement-admission.js';

interface PinnedJsonlInternals {
  tracker: { openHandles: Set<SessionHandle>; writers: Map<string, SessionHandle | null>; pending: Map<string, unknown> };
  migrationPreparations: Map<string, unknown>;
  coldLogMemo: Map<string, unknown>;
  [key: string]: unknown;
}

export function nativeServiceInstance<T extends object>(value: T): T {
  return (Reflect.get(value, Symbol.for('cordis.original')) as T | undefined) ?? value;
}

/** Version-bound instance Adapter. It never patches prototypes or other Hosts. */
export class NativePersistenceAdapter {
  private readonly raw: PinnedJsonlInternals;
  private originalStat: SessionPersistence['stat'];
  private originalList: SessionPersistence['list'];
  private readonly restore: Array<() => void> = [];
  private detached = false;
  private active = true;
  private readonly managedHandles = new WeakSet<object>();
  constructor(private readonly provider: SessionPersistence, private readonly admission: NativeAdmission) {
    const raw = nativeServiceInstance(provider) as unknown as PinnedJsonlInternals;
    if (!(raw.tracker?.openHandles instanceof Set) || !(raw.tracker.writers instanceof Map)
      || !(raw.tracker.pending instanceof Map) || !(raw.migrationPreparations instanceof Map)
      || !(raw.coldLogMemo instanceof Map)) throw new Error('JSONL retirement runtime shape does not match the pinned provider.');
    this.raw = raw;
    this.originalStat = provider.stat.bind(provider);
    this.originalList = provider.list.bind(provider);
  }
  stat(id: string): Promise<SessionPersistenceSnapshot | undefined> { return this.originalStat(SessionId(id)); }
  list(): Promise<readonly SessionPersistenceSnapshot[]> { return this.originalList(); }
  busy(id: string): boolean {
    return this.raw.tracker.pending.has(id) || this.raw.tracker.writers.has(id)
      || [...this.raw.tracker.openHandles].some(handle => handle.id === id)
      || this.raw.migrationPreparations.size !== 0;
  }
  forget(id: string): void {
    if (this.busy(id)) throw new NativeAdmissionError('A persistence reference still owns this session.');
    this.raw.coldLogMemo.delete(id);
  }
  install(): () => Promise<void> {
    this.originalStat = this.provider.stat.bind(this.provider);
    this.originalList = this.provider.list.bind(this.provider);
    const route = (target: object, name: string, idFor: (args: unknown[]) => string, transform?: (value: unknown) => unknown, globalRead = false) => {
      target = nativeServiceInstance(target);
      const record = target as Record<string, unknown>;
      const original = record[name];
      if (typeof original !== 'function') throw new Error(`Missing pinned JSONL route ${name}.`);
      const own = Object.getOwnPropertyDescriptor(target, name);
      const adapter = this;
      const wrapper = function (this: object, ...args: unknown[]) {
        const receiver = this;
        if (adapter.detached) return Promise.reject(new NativeAdmissionError('This native guard belongs to a replaced retirement owner.'));
        const id = idFor(args);
        if (!adapter.active) {
          if (adapter.admission.isRetired(id)) return Promise.reject(new NativeAdmissionError('This session has a retirement tombstone.'));
          return Reflect.apply(original, receiver, args);
        }
        const run = () => adapter.admission.track(id, async () => {
          const value = await Reflect.apply(original, receiver, args);
          return transform ? transform(value) : value;
        });
        return globalRead ? adapter.admission.trackGlobal(run) : run();
      };
      Object.defineProperty(target, name, { configurable: true, writable: true, value: wrapper });
      this.restore.push(() => {
        if (record[name] !== wrapper) throw new Error(`JSONL route ${name} changed while retirement was installed.`);
        if (own) Object.defineProperty(target, name, own); else delete record[name];
      });
    };
    const headerId = (args: unknown[]) => String((args[0] as SessionHeader).id);
    route(this.provider, 'create', headerId, value => this.manage(value as SessionHandle));
    route(this.provider, 'open', args => String(args[0]), value => this.manage(value as SessionHandle), true);
    for (const method of ['persistBatch', 'persistHeader', 'truncateTornTail', 'acquireWriteLease']) {
      route(this.provider, method, headerId);
    }
    route(this.provider, 'readStoredLog', args => String(args[1]), undefined, true);
    route(this.provider, 'resolveCurrentLog', args => String(args[0]));
    // Metadata observations must omit admitted/retired lifecycles, including a
    // read which began before the durable fence and returns afterwards.
    const instance = nativeServiceInstance(this.provider);
    const rawStat = instance.stat;
    const rawList = instance.list;
    const adapter = this;
    instance.stat = async function (id, options) {
      if (adapter.detached) throw new NativeAdmissionError('This native observer belongs to a replaced retirement owner.');
      if (adapter.admission.isRetired(id)) return undefined;
      const value = await adapter.admission.trackGlobal(() => adapter.admission.track(id, () => rawStat.call(this, id, options)));
      return adapter.admission.isRetired(id) ? undefined : value;
    };
    instance.list = async function (options) {
      if (adapter.detached) throw new NativeAdmissionError('This native observer belongs to a replaced retirement owner.');
      return (await adapter.admission.trackGlobal(() => rawList.call(this, options))).filter(item => !adapter.admission.isRetired(item.header.id));
    };
    this.restore.push(() => { instance.stat = rawStat; instance.list = rawList; });
    return async () => {
      await this.admission.drain();
      this.active = false;
      // Retired IDs retain a narrow fail-closed guard after plugin withdrawal.
      // Other IDs continue to use the same original native instance routes.
      if (this.originalRetired()) return;
      for (const undo of [...this.restore].reverse()) undo();
      this.restore.length = 0;
    };
  }
  forceRestore(): void {
    this.detached = true; this.active = false;
    for (const undo of [...this.restore].reverse()) undo();
    this.restore.length = 0;
  }
  private originalRetired(): boolean {
    // Querying the native inventory cannot discover erased IDs; the controller
    // owns the durable tombstone snapshot independently of the closed domain.
    return this.admission.hasTombstones();
  }
  private manage(handle: SessionHandle): SessionHandle {
    if (this.managedHandles.has(handle)) return handle;
    this.managedHandles.add(handle);
    const methods = ['read', 'append', 'flush'] as const;
    for (const name of methods) {
      const original = handle[name];
      Object.defineProperty(handle, name, { configurable: true, writable: true,
        value: (...args: unknown[]) => !this.active && !this.admission.isRetired(handle.id)
          ? Reflect.apply(original, handle, args)
          : this.admission.track(handle.id, async () => Reflect.apply(original, handle, args)) });
    }
    return handle;
  }
}
