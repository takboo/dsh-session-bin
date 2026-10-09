import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readdir, realpath, lstat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { openRegularFile, RegularFileRefusal, renameWindowsWriteThrough, syncDirectory } from './platform-files.js';
import { dirname, join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { workspaceDomainState, workspaceRecord } from '@deepseek-ai/dsh-workspace';
import { z } from 'zod';
import type { LifecycleKey, RetirementRequest } from '../operations/retirement.js';

export interface NativeMetadataAdmission {
  assertAllowed(sessionId: string): void;
  track<T>(sessionId: string, work: () => Promise<T>): Promise<T>;
  trackGlobal<T>(work: () => Promise<T>): Promise<T>;
  isRetired(sessionId: string): boolean;
  bypass<T>(sessionId: string, work: () => T): T;
  withoutBypass<T>(work: () => T): T;
}
export class NativeMetadataRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'NativeMetadataRefusal'; }
}
const cachePhysicalIdentitySchema = z.object({
  dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^[1-9]\d*$/), birthtimeNs: z.string().regex(/^[1-9]\d*$/),
}).strict();
export const nativeMetadataSnapshotSchema = z.object({
  schemaVersion: z.literal(1), sessionId: z.string().min(1),
  global: z.object({ archived: z.boolean(), pinned: z.boolean() }).strict(),
  workspaces: z.array(z.object({ workspaceId: z.string(), record: workspaceRecord }).strict()),
  cache: z.object({ present: z.boolean(), digest: z.string().nullable(), location: z.string().nullable(),
    documentDigest: z.string().nullable(), memoryDigest: z.string().nullable(), physicalIdentity: cachePhysicalIdentitySchema.optional() }).strict(),
  queryProvider: z.enum(['none', 'sqlite-0.2.0-rc.2', 'sqlite-memory-disabled-0.2.0-rc.2']), queryPath: z.string().nullable(),
}).strict();
export type NativeMetadataSnapshot = z.infer<typeof nativeMetadataSnapshotSchema>;

type Method = (...args: any[]) => any;
type ObjectPort = Record<PropertyKey, any>;
function object(value: unknown): ObjectPort | undefined {
  return value !== null && typeof value === 'object' ? value as ObjectPort : undefined;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
const methods = (port: ObjectPort, names: string[]) => names.every(name => typeof port[name] === 'function');
const windowsCacheStagePrefix = '.dsh-session-bin-cache-';
type CachePhysicalIdentity = NonNullable<NativeMetadataSnapshot['cache']['physicalIdentity']>;
function physicalIdentity(stat: { dev: bigint; ino: bigint; birthtimeNs: bigint }): CachePhysicalIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}
function samePhysicalIdentity(left: CachePhysicalIdentity | undefined, right: CachePhysicalIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}
function cacheStageBasename(snapshot: NativeMetadataSnapshot['cache'], expected: LifecycleKey, request: RetirementRequest): string {
  const value = digest({ schemaVersion: 1, expected, request, cache: snapshot });
  return `${windowsCacheStagePrefix}${value}.stage`;
}

/** Version-bound metadata participant. The composition verifies package/source
 * fingerprints before open; this adapter additionally checks concrete instance
 * shape. It neither removes files nor writes SQLite rows. */
export class NativeMetadataAdapter {
  private readonly targets = new Set<string>();
  private readonly retained = new Map<string, number>();
  private readonly followers = new Map<string, number>();
  private readonly followerStops = new Map<string, Set<() => Promise<void>>>();
  private readonly activationTarget = new AsyncLocalStorage<string>();
  private readonly apiHandles = new Map<string, ObjectPort>();
  private readonly operations = new Map<string, number>();
  private readonly queueTarget = new AsyncLocalStorage<string>();
  private readonly receivers = new AsyncLocalStorage<ObjectPort>();
  private readonly restores: Array<() => void> = [];
  private readonly guardedMethods: Array<{ port: ObjectPort; name: string; replacement: Method }> = [];
  private readonly guardedEntities = new WeakSet<object>();
  private installed = false;
  private disposed = false;
  private detached = false;
  private fallbackRetired = new Set<string>();
  private readonly queryConfiguration: { path: string; openAt: string } | undefined;
  private readonly queryProvider: NativeMetadataSnapshot['queryProvider'];
  private readonly cacheTable: ObjectPort | undefined;
  private readonly cacheDirectory: string | undefined;
  private readonly agents: ObjectPort | undefined;
  private moveCacheDocument = renameWindowsWriteThrough;
  private clearCacheStage = async (handle: FileHandle): Promise<void> => { await handle.truncate(0); await handle.sync(); };
  private removeCacheStage = unlink;

  private constructor(private readonly ctx: Context, private readonly admission: NativeMetadataAdmission,
    private readonly workspace: ObjectPort, private readonly sessions: ObjectPort,
    private readonly cache: ObjectPort | undefined, private readonly query: ObjectPort | undefined,
    private readonly controller: ObjectPort | undefined) {
    this.queryConfiguration = query ? { path: query.config.path, openAt: query.config.openAt } : undefined;
    this.queryProvider = !query ? 'none' : query.config.openAt === 'never' ? 'sqlite-memory-disabled-0.2.0-rc.2' : 'sqlite-0.2.0-rc.2';
    this.cacheTable = cache?.requireTable();
    this.cacheDirectory = this.cacheTable?.host.unit.dir;
    this.agents = controller ? NativeMetadataAdapter.get(ctx, 'agents') : undefined;
  }

  private static get(ctx: Context, name: string): ObjectPort | undefined {
    const value = object(ctx.get(name));
    return object(value?.[Symbol.for('cordis.original')] ?? value);
  }
  static async open(ctx: Context, admission: NativeMetadataAdmission): Promise<NativeMetadataAdapter | undefined> {
    const workspace = this.get(ctx, 'workspaceRegistry');
    const sessions = this.get(ctx, 'sessions');
    const cache = this.get(ctx, 'sessionProjectionCache');
    const query = this.get(ctx, 'sessionQuery');
    const controller = this.get(ctx, 'sessionController');
    if (!workspace || !sessions || workspace.constructor.name !== 'WorkspaceRegistry' || sessions.constructor.name !== 'SessionStore'
      || !methods(workspace, ['list', 'requireTable', 'requireState', 'setState', 'enqueueOperation', 'indexHeader', 'readSessionHeader'])
      || ![workspace.headers, workspace.sessionPaths, workspace.invalidSessionPaths].every(map => map instanceof Map)
      || !methods(sessions, ['get', 'prepare', 'enter', 'announce'])) return undefined;
    if (cache && (cache.constructor.name !== 'SessionProjectionCache' || !(cache.dirty instanceof Map)
      || !methods(cache, ['put', 'requireTable', 'write', 'coldSnapshot', 'hydratePrepared', 'cachedSnapshot', 'cachedPredecessorTitle']))) return undefined;
    if (cache) {
      const table = cache.requireTable(); const domain = ctx.storageDomain.get('session_projcache') as unknown as ObjectPort | undefined;
      if (table?.constructor.name !== 'KvTableImpl' || table.tableName !== 'sessions' || !(table.records instanceof Map)
        || table.host?.domainName !== 'session_projcache' || table.host.unit?.constructor.name !== 'PerRecordJsonUnit'
        || table.host.unit.descriptor?.name !== 'session_projcache' || table.host.unit.descriptor.version !== 7
        || table.host.unit.descriptor.layout !== 'per-record' || typeof table.host.unit.dir !== 'string'
        || !methods(table.host, ['enqueue', 'emitChanged', 'assertReadable'])
        || !methods(table.host.unit, ['loadAll', 'deleteRecord', 'tableDir']) || domain?.unit !== table.host.unit) return undefined;
    }
    if (query) {
      const enabled = ['startup', 'first-search'].includes(query.config?.openAt);
      const disabledMemory = query.config?.openAt === 'never' && query.config.path === ':memory:'
        && query._db === undefined && query._ready === undefined;
      if (query.constructor.name !== 'SqliteSessionQueryEngine' || (!enabled && !disabledMemory)
        || typeof query.config?.path !== 'string'
        || !methods(query, ['searchSessions', 'listSessions', 'observeSession', '_serialized']) || !(query._observations?.cache instanceof Map)
        || !methods(query._observations, ['read', 'store'])) return undefined;
    }
    if (controller && (controller.constructor.name !== 'SessionController' || !(controller.history?.closeFollowers instanceof Set)
      || !methods(controller.history, ['page', 'follow', 'sourceFor'])
      || controller.agents?.constructor.name !== 'ApiSessionAgentController'
      || !methods(controller.agents, ['resumeObserved', 'createOrAdopt'])
      || !methods(controller.listState ?? {}, ['summarizeCold'])
      || !methods(this.get(ctx, 'agents') ?? {}, ['create', 'resume', 'get']))) return undefined;
    return new NativeMetadataAdapter(ctx, admission, workspace, sessions, cache, query, controller);
  }
  private assert(id: string): void {
    this.targets.add(id);
    if (this.disposed) {
      if (this.fallbackRetired.has(id)) throw new NativeMetadataRefusal('native/retired', 'This retired session remains fenced after adapter withdrawal.');
      return;
    }
    this.admission.assertAllowed(id);
  }
  private tracked<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.targets.add(id);
    if (this.disposed) { this.assert(id); return work(); }
    return this.admission.trackGlobal(() => this.admission.track(id, async () => {
      this.assert(id);
      this.increment(this.operations, id, 1);
      try { return await work(); }
      finally { this.increment(this.operations, id, -1); }
    }));
  }
  private increment(map: Map<string, number>, id: string, delta: number): void {
    const next = (map.get(id) ?? 0) + delta;
    if (next === 0) map.delete(id); else map.set(id, next);
  }
  private refuse(code: string, message: string): never { throw new NativeMetadataRefusal(code, message); }
  private assertInstances(): void {
    if (this.guardedMethods.some(({ port, name, replacement }) => port[name] !== replacement)) {
      this.refuse('native/guard-replaced', 'A native metadata admission guard was replaced.');
    }
    if (NativeMetadataAdapter.get(this.ctx, 'workspaceRegistry') !== this.workspace
      || NativeMetadataAdapter.get(this.ctx, 'sessions') !== this.sessions
      || NativeMetadataAdapter.get(this.ctx, 'sessionProjectionCache') !== this.cache
      || NativeMetadataAdapter.get(this.ctx, 'sessionQuery') !== this.query
      || NativeMetadataAdapter.get(this.ctx, 'sessionController') !== this.controller
      || (this.controller && NativeMetadataAdapter.get(this.ctx, 'agents') !== this.agents)
      || (this.cache && (this.cache.requireTable() !== this.cacheTable || this.cacheTable!.host.unit.dir !== this.cacheDirectory))
      || (this.query && (this.query.config.path !== this.queryConfiguration!.path
        || this.query.config.openAt !== this.queryConfiguration!.openAt))
      || (this.queryProvider === 'sqlite-memory-disabled-0.2.0-rc.2' && (this.query!._db !== undefined || this.query!._ready !== undefined))) {
      this.refuse('native/composition-changed', 'Native metadata service composition changed.');
    }
  }
  private assertCold(id: string): void {
    if (this.sessions.get(id) !== undefined || NativeMetadataAdapter.get(this.ctx, 'agents')?.get(id) !== undefined) {
      this.refuse('native/session-live', 'Native deletion currently accepts only cold sessions.');
    }
    const cached = this.query?._observations.cache.get(id);
    if (cached?.refs > 0 || (this.retained.get(id) ?? 0) > 0) this.refuse('native/query-retained', 'A retained query observation still owns this session.');
    if ((this.followers.get(id) ?? 0) > 0) this.refuse('native/follow-retained', 'A history follower still owns this session.');
    // Followers predating install have no target key in this SDK. Refuse rather
    // than closing unrelated streams or assuming that removed disposed them.
    const knownFollowers = [...this.followers.values()].reduce((sum, count) => sum + count, 0);
    if ((this.controller?.history.closeFollowers.size ?? 0) > knownFollowers) this.refuse('native/unknown-follow', 'A history follower predates native admission tracking.');
    if (this.cache && [...this.cache.dirty.keys()].some(session => session.id === id)) this.refuse('native/cache-dirty', 'Target cache write-behind is not quiescent.');
  }
  /** Explicit deletion preparation may unload an idle API-owned lifecycle.
   * No bare registry Agent, foreign handle, or unknown reader is disposed. */
  async releaseIdle(id: string): Promise<void> {
    this.assertInstances();
    const handle = this.apiHandles.get(id);
    if (!handle) return;
    const agent = handle.agent;
    const registry = this.agents!;
    if (registry.get(id) !== agent || this.sessions.get(id) !== agent.session) return;
    const activity = await this.admission.withoutBypass(() => this.ctx.waterfall('workspace/session-activity',
      { sessionId: id as never }, async () => []));
    // Inspect after the asynchronous activity query; dispose starts in this
    // same synchronous turn, before another activation can be admitted.
    if (activity.length || agent.constructor.name !== 'ReactLoopAgent' || agent.phase?.kind !== 'idle'
      || agent.status !== 'idle' || !Array.isArray(agent.inbox?.nextTurn)
      || !Array.isArray(agent.inbox?.nextStep) || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
      this.refuse('native/session-active', 'Native deletion refuses active or queued work.');
    }
    if (!this.workspace.archivedSessionIds.includes(id)) this.refuse('native/not-archived', 'Only an archived target may be unloaded.');
    if (registry.get(id) !== agent || this.sessions.get(id) !== agent.session) this.refuse('native/session-live', 'The API lifecycle changed.');
    await this.admission.bypass(id, async () => {
      await handle.dispose();
      for (const stop of [...(this.followerStops.get(id) ?? [])]) await stop();
      // Disposal checkpoints projections asynchronously. Join its actual put
      // operations and the durable table queue before taking the cold snapshot.
      if (this.cache) await this.cache.requireTable().host.enqueue(async () => undefined);
      const summary = this.controller!.listState.summarizeCold(agent.session.header);
      this.admission.withoutBypass(() => (this.ctx.emit as Method)('api-session/added', summary));
    });
    this.apiHandles.delete(id);
  }
  private async cacheView(table: ObjectPort, id: string, acceptedStage?: string): Promise<NativeMetadataSnapshot['cache']> {
    table.host.assertReadable();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) this.refuse('native/cache-key-unsupported', 'The pinned cache backend cannot own this record key.');
    const directory = resolve(table.host.unit.dir);
    // The pinned PerRecordJsonUnit bootstraps an empty tree from this retained
    // whole-unit file on every OS. Never certify erasure while that source exists.
    const legacyPath = join(dirname(directory), `${table.host.unit.descriptor.name}.json`);
    try {
      await lstat(legacyPath);
      this.refuse('native/cache-unclassified-resource', 'A legacy whole-unit cache could republish the retired target document.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let location: string;
    try { location = await realpath(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      location = join(await realpath(dirname(directory)), 'session_projcache');
    }
    const tableDirectory: string = table.host.unit.tableDir('sessions');
    let names: string[];
    try { names = await readdir(tableDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; names = []; }
    if (names.some(name => name.startsWith(`${id}.json.bak.`) || /^\.[a-f0-9-]+\.tmp$/.test(name)
      || (name.startsWith(windowsCacheStagePrefix) && name !== acceptedStage))) {
      this.refuse('native/cache-unclassified-resource', 'A cache backup or unclassified staging document prevents complete target erasure.');
    }
    let documentDigest: string | null = null;
    let documentIdentity: CachePhysicalIdentity | undefined;
    const path = join(tableDirectory, `${id}.json`);
    try {
      let handle;
      try { handle = await openRegularFile(path, 'read'); }
      catch (error) {
        if (error instanceof RegularFileRefusal) this.refuse(error.code === 'platform/unsafe-file' ? 'native/cache-unsafe-document' : 'native/cache-document-changed', error.message);
        throw error;
      }
      try {
        const before = await handle.stat({ bigint: true });
        const bytes = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        const current = await lstat(path, { bigint: true });
        if (!current.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.birthtimeNs !== after.birthtimeNs || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
          || after.nlink !== 1n || after.dev !== current.dev || after.ino !== current.ino
          || after.birthtimeNs !== current.birthtimeNs || after.size !== current.size
          || after.mtimeNs !== current.mtimeNs || after.ctimeNs !== current.ctimeNs) {
          this.refuse('native/cache-document-changed', 'The physical cache document changed while observing its bytes.');
        }
        documentDigest = createHash('sha256').update(bytes).digest('hex');
        if (process.platform === 'win32') documentIdentity = physicalIdentity(after);
      } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const memory = table.records.get(id);
    const memoryDigest = memory === undefined ? null : digest(memory);
    const present = documentDigest !== null || memoryDigest !== null;
    return { present, digest: present ? digest({ documentDigest, memoryDigest }) : null,
      location, documentDigest, memoryDigest, ...(documentIdentity ? { physicalIdentity: documentIdentity } : {}) };
  }
  private async openCacheDocument(path: string, access: 'read' | 'write'): Promise<FileHandle> {
    try { return await openRegularFile(path, access); }
    catch (error) {
      if (error instanceof RegularFileRefusal) this.refuse(error.code === 'platform/unsafe-file' ? 'native/cache-unsafe-document' : 'native/cache-document-changed', error.message);
      throw error;
    }
  }
  private async pathAbsent(path: string): Promise<boolean> {
    try { await lstat(path); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  }
  private async frozenCacheBytes(handle: FileHandle, snapshot: NativeMetadataSnapshot['cache'], allowCleared: boolean): Promise<boolean> {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !samePhysicalIdentity(physicalIdentity(before), snapshot.physicalIdentity)) return false;
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) return false;
    return allowCleared && bytes.length === 0
      || snapshot.documentDigest !== null && createHash('sha256').update(bytes).digest('hex') === snapshot.documentDigest;
  }
  private async eraseWindowsCache(snapshot: NativeMetadataSnapshot['cache'], id: string,
    expected: LifecycleKey, request: RetirementRequest, table: ObjectPort): Promise<boolean> {
    if (snapshot.documentDigest !== null && snapshot.physicalIdentity === undefined) return false;
    if (snapshot.documentDigest === null && snapshot.physicalIdentity !== undefined) return false;
    const tableDirectory: string = table.host.unit.tableDir('sessions');
    const originalPath = join(tableDirectory, `${id}.json`);
    const stageName = cacheStageBasename(snapshot, expected, request);
    const stagePath = join(tableDirectory, stageName);
    const current = await this.cacheView(table, id, stageName);
    if (current.location !== snapshot.location || (current.documentDigest !== null && current.documentDigest !== snapshot.documentDigest)
      || (current.memoryDigest !== null && current.memoryDigest !== snapshot.memoryDigest)
      || (!snapshot.present && current.present)) return false;
    let originalAbsent = await this.pathAbsent(originalPath);
    let stageAbsent = await this.pathAbsent(stagePath);
    if (!originalAbsent && !stageAbsent) return false;
    if (!originalAbsent) {
      if (snapshot.physicalIdentity === undefined || current.documentDigest !== snapshot.documentDigest
        || !samePhysicalIdentity(current.physicalIdentity, snapshot.physicalIdentity)) return false;
      let handle: FileHandle;
      try { handle = await this.openCacheDocument(originalPath, 'write'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      try {
        if (!await this.frozenCacheBytes(handle, snapshot, false)) return false;
        try { await this.moveCacheDocument(originalPath, stagePath); }
        catch (error) {
          if (['EEXIST', 'EXDEV', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
          throw error;
        }
      } finally { await handle.close(); }
      originalAbsent = await this.pathAbsent(originalPath);
      stageAbsent = await this.pathAbsent(stagePath);
      if (!originalAbsent || stageAbsent) return false;
    }
    if (!stageAbsent) {
      let handle: FileHandle;
      try { handle = await this.openCacheDocument(stagePath, 'write'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      try {
        if (!await this.frozenCacheBytes(handle, snapshot, true)) return false;
        await this.clearCacheStage(handle);
      } finally { await handle.close(); }
      await this.removeCacheStage(stagePath);
      if (!await this.pathAbsent(stagePath)) return false;
    }
    if (!await this.pathAbsent(originalPath) || !await this.pathAbsent(stagePath)) return false;
    table.records.delete(id);
    this.admission.withoutBypass(() => table.host.emitChanged({ domain: table.host.domainName, table: 'sessions', key: id, operation: 'deleted' }));
    const final = await this.cacheView(table, id, stageName);
    return final.location === snapshot.location && !final.present && await this.pathAbsent(stagePath);
  }
  private async eraseCache(snapshot: NativeMetadataSnapshot['cache'], id: string,
    expected: LifecycleKey, request: RetirementRequest): Promise<boolean> {
    const table = this.cacheTable;
    if (!table) return !snapshot.present && snapshot.location === null;
    return table.host.enqueue(async () => {
      if (process.platform === 'win32') return this.eraseWindowsCache(snapshot, id, expected, request, table);
      const current = await this.cacheView(table, id);
      if (current.location !== snapshot.location || (current.documentDigest !== null && current.documentDigest !== snapshot.documentDigest)
        || (current.memoryDigest !== null && current.memoryDigest !== snapshot.memoryDigest)
        || (!snapshot.present && current.present)) return false;
      // KvTable.delete skips the medium when memory lacks the key. This owner
      // endpoint must remove the exact record document even after lost put ack.
      await table.host.unit.deleteRecord('sessions', id);
      const tableDirectory: string = table.host.unit.tableDir('sessions');
      try { await syncDirectory(tableDirectory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      table.records.delete(id);
      this.admission.withoutBypass(() => table.host.emitChanged({ domain: table.host.domainName, table: 'sessions', key: id, operation: 'deleted' }));
      const final = await this.cacheView(table, id);
      return final.location === snapshot.location && !final.present;
    });
  }
  async capture(sessionId: string): Promise<NativeMetadataSnapshot> {
    return this.admission.bypass(sessionId, () => this.captureInner(sessionId));
  }
  private async captureInner(sessionId: string): Promise<NativeMetadataSnapshot> {
    this.targets.add(sessionId);
    this.assertInstances(); this.assertCold(sessionId);
    const activity = await this.admission.withoutBypass(() => this.ctx.waterfall('workspace/session-activity',
      { sessionId: sessionId as never }, async () => []));
    if (activity.length !== 0) this.refuse('native/session-active', 'Native deletion refuses active work.');
    this.assertCold(sessionId);
    const domain = this.ctx.storageDomain.get('workspace');
    if (!domain) throw new Error('Native workspace domain is unavailable.');
    const global = workspaceDomainState.parse(domain.global.get());
    if (!global.archivedSessionIds.some(id => id === sessionId)) this.refuse('native/not-archived', 'Native metadata preparation requires an archived session.');
    const workspaces: NativeMetadataSnapshot['workspaces'] = [];
    for (const [workspaceId, raw] of this.workspace.requireTable().entries()) {
      const record = workspaceRecord.parse(raw);
      if (!record.sessionIds.some(id => id === sessionId)) continue;
      if (record.sessionIds.some(id => id !== sessionId && this.workspace.sessionPaths.get(id) !== record.path)) {
        this.refuse('native/workspace-pruning-required', 'Target removal would prune an unrelated Workspace candidate.');
      }
      workspaces.push({ workspaceId, record });
    }
    const cache = this.cacheTable ? await this.cacheTable.host.enqueue(() => this.cacheView(this.cacheTable!, sessionId))
      : { present: false, digest: null, location: null, documentDigest: null, memoryDigest: null };
    return nativeMetadataSnapshotSchema.parse({ schemaVersion: 1, sessionId,
      global: { archived: global.archivedSessionIds.includes(sessionId as never), pinned: global.pinnedSessionIds.includes(sessionId as never) },
      workspaces, cache,
      queryProvider: this.queryProvider, queryPath: this.queryConfiguration?.path ?? null });
  }
  private wrap(port: ObjectPort, name: string, replace: (original: Method) => Method): void {
    const descriptor = Object.getOwnPropertyDescriptor(port, name);
    const original: Method = port[name];
    const adapter = this;
    const guarded = replace((...args: unknown[]) => Reflect.apply(original, adapter.receivers.getStore() ?? port, args));
    const replacement = function (this: ObjectPort, ...args: unknown[]) {
      if (adapter.detached) throw new NativeMetadataRefusal('native/stale-reference', 'Reacquire native methods after retirement adapter takeover.');
      return adapter.receivers.run(this, () => guarded(...args));
    };
    Object.defineProperty(port, name, { configurable: true, writable: true, value: replacement });
    this.guardedMethods.push({ port, name, replacement });
    this.restores.push(() => {
      if (port[name] !== replacement) throw new Error(`Native metadata guard ${name} was replaced before withdrawal.`);
      if (descriptor) Object.defineProperty(port, name, descriptor); else delete port[name];
    });
  }
  private guardEntity(entity: ObjectPort): void {
    if (this.guardedEntities.has(entity)) return;
    this.guardedEntities.add(entity);
    this.wrap(entity, 'attachSession', original => (id: string) => this.tracked(id, async () => {
      const result = await original(id); this.assert(id); return result;
    }));
  }
  private guardedObservation(id: string, observation: ObjectPort): ObjectPort {
    this.increment(this.retained, id, 1);
    let disposed = false;
    return new Proxy(observation, { get: (target, property) => {
      if (property === Symbol.dispose) return () => {
        if (disposed) return;
        disposed = true;
        try { target[Symbol.dispose](); }
        finally { this.increment(this.retained, id, -1); }
      };
      if (property === 'retain') return () => { this.assert(id); return this.guardedObservation(id, target.retain()); };
      if (property === 'events' || property === 'projections') this.assert(id);
      return Reflect.get(target, property, target);
    } });
  }
  async install(): Promise<() => Promise<void>> {
    if (this.installed) throw new Error('Native metadata adapter is already installed.');
    this.assertInstances(); this.installed = true;
    try {
      for (const name of ['workspace', ...(this.cache ? ['session_projcache'] : [])]) {
        const domain = this.ctx.storageDomain.get(name) as unknown as ObjectPort | undefined;
        if (!domain || domain.constructor.name !== 'DomainImpl' || !methods(domain, ['emitChanged'])) {
          throw new Error('Native metadata domain publication shape changed.');
        }
        this.wrap(domain, 'emitChanged', original => (change: unknown) => this.admission.withoutBypass(() => original(change)));
      }
      for (const name of ['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession']) {
        this.wrap(this.workspace, name, original => (id: string, ...args: unknown[]) => this.tracked(id,
          () => this.queueTarget.run(id, async () => original(id, ...args))));
      }
      this.wrap(this.workspace, 'enqueueOperation', original => (operation: () => Promise<unknown>) => {
        const id = this.queueTarget.getStore();
        return original(async () => { if (id !== undefined) this.assert(id); return operation(); });
      });
      this.wrap(this.workspace, 'setState', original => async (next: ObjectPort) => {
        const id = this.queueTarget.getStore();
        if (id !== undefined) this.assert(id);
        return original(next);
      });
      this.wrap(this.workspace, 'indexHeader', original => (header: ObjectPort) => this.tracked(header.id, async () => {
        const result = await original(header); this.assert(header.id); return result;
      }));
      this.wrap(this.workspace, 'readSessionHeader', original => (id: string) => this.tracked(id, async () => {
        const result = await original(id); this.assert(id); return result;
      }));
      for (const entity of this.workspace.list()) this.guardEntity(entity);
      for (const name of ['create', 'initializeDefault']) this.wrap(this.workspace, name, original => async (...args: unknown[]) => {
        const entity = await original(...args); if (entity) this.guardEntity(entity); return entity;
      });
      this.wrap(this.sessions, 'prepare', original => (id: string | undefined, ...args: unknown[]) => {
        if (id !== undefined) this.assert(id);
        const session = original(id, ...args); this.assert(session.id); return session;
      });
      for (const name of ['enter', 'announce']) this.wrap(this.sessions, name, original => (session: ObjectPort) => {
        this.assert(session.id); return original(session);
      });
      if (this.cache) {
        this.wrap(this.cache, 'put', original => (id: string, ...args: unknown[]) => this.tracked(id, async () => original(id, ...args)));
        for (const name of ['cachedSnapshot', 'cachedPredecessorTitle', 'coldSnapshot']) this.wrap(this.cache, name,
          original => (header: ObjectPort, ...args: unknown[]) => { this.assert(header.id); return original(header, ...args); });
        this.wrap(this.cache, 'hydratePrepared', original => (session: ObjectPort, ...args: unknown[]) => {
          this.assert(session.id); return original(session, ...args);
        });
      }
      if (this.query) {
        this.wrap(this.query, '_serialized', original => (signal: AbortSignal | undefined, operation: () => Promise<unknown>) =>
          this.admission.trackGlobal(async () => original(signal, operation)));
        this.wrap(this.query._observations, 'read', original => (id: string, ...args: unknown[]) => this.tracked(id, async () => {
          const observation = await original(id, ...args);
          try { this.assert(id); return this.guardedObservation(id, observation); }
          catch (error) { observation[Symbol.dispose](); throw error; }
        }));
        this.wrap(this.query._observations, 'store', original => (id: string, ...args: unknown[]) => { this.assert(id); return original(id, ...args); });
        for (const name of ['readSession', 'readTitle', 'readTitleSnapshot', 'listEvents', 'filterEvents', 'readSurface', 'traceSession']) {
          if (typeof this.query[name] === 'function') this.wrap(this.query, name, original => (id: string, ...args: unknown[]) =>
            this.tracked(id, async () => { const result = await original(id, ...args); this.assert(id); return result; }));
        }
        for (const name of ['searchEvents', 'readEvent', 'traceEvent']) if (typeof this.query[name] === 'function') {
          this.wrap(this.query, name, original => (request: ObjectPort, ...args: unknown[]) => this.tracked(request.sessionId,
            async () => { const result = await original(request, ...args); this.assert(request.sessionId); return result; }));
        }
      }
      if (this.controller) {
        const adapter = this;
        // API Session drops the returned AgentHandle after activation. Retain
        // that exact disposal capability only inside its matching target call.
        for (const name of ['resumeObserved', 'createOrAdopt']) {
          this.wrap(this.controller.agents, name, original => (id: string, ...args: unknown[]) =>
            this.tracked(id, () => this.activationTarget.run(id, async () => original(id, ...args))));
        }
        const agents = this.agents!;
        for (const name of ['create', 'resume']) {
          this.wrap(agents, name, original => (options: ObjectPort, ...args: unknown[]) => {
            const id = String(name === 'create' ? options.sessionId : options.resumeSessionId);
            return this.tracked(id, async () => {
              const handle = await original(options, ...args);
              if (this.activationTarget.getStore() === id && options.parentAgent === undefined
                && handle.agent.id === id && handle.agent.session.header.origin !== 'subagent'
                && typeof handle.dispose === 'function') this.apiHandles.set(id, handle);
              return handle;
            });
          });
        }
        this.restores.push((this.ctx.on as Method)('agent/disposed', ({ agent }: { agent: ObjectPort }) => {
          if (this.apiHandles.get(agent.id)?.agent === agent) this.apiHandles.delete(agent.id);
        }, { global: true }));
        this.wrap(this.controller.history, 'follow', original => function (request: ObjectPort, signal: AbortSignal) {
          const id = String(request.address.sessionId);
          adapter.assert(id);
          return (async function* () {
            adapter.assert(id); adapter.increment(adapter.followers, id, 1);
            const cancellation = new AbortController();
            const iterator = original(request, AbortSignal.any([signal, cancellation.signal]));
            const stops = adapter.followerStops.get(id) ?? new Set<() => Promise<void>>();
            adapter.followerStops.set(id, stops);
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              adapter.increment(adapter.followers, id, -1);
              stops.delete(stop); if (!stops.size) adapter.followerStops.delete(id);
            };
            const stop = async () => { cancellation.abort(); await iterator.return(); finish(); };
            stops.add(stop);
            try { for await (const frame of iterator) { adapter.assert(id); yield frame; } }
            finally { finish(); }
          })();
        });
      }
    } catch (error) {
      for (const restore of [...this.restores].reverse()) restore();
      this.restores.length = 0; this.installed = false; throw error;
    }
    let closing: Promise<void> | undefined;
    return () => closing ??= (async () => {
      this.fallbackRetired = new Set([...this.targets].filter(id => this.admission.isRetired(id)));
      this.disposed = true;
      this.apiHandles.clear();
      if (this.fallbackRetired.size === 0) {
        for (const restore of [...this.restores].reverse()) restore();
        this.restores.length = 0;
      }
    })();
  }
  /** The verified owner completes all asynchronous takeover work before this
   * synchronous restoration and installs its successor guards without yielding. */
  forceRestore(): void {
    if (this.restores.length && this.guardedMethods.some(({ port, name, replacement }) => port[name] !== replacement)) {
      throw new Error('Native metadata guards changed before trusted takeover.');
    }
    this.detached = true; this.disposed = true;
    for (const restore of [...this.restores].reverse()) restore();
    this.restores.length = 0; this.guardedMethods.length = 0; this.fallbackRetired.clear(); this.apiHandles.clear();
  }
  async converge(input: NativeMetadataSnapshot, expected: LifecycleKey, request: RetirementRequest): Promise<boolean> {
    const snapshot = nativeMetadataSnapshotSchema.parse(input);
    const id = snapshot.sessionId;
    this.targets.add(id); this.assertInstances();
    if (snapshot.queryProvider !== this.queryProvider
      || snapshot.queryPath !== (this.queryConfiguration?.path ?? null)) return false;
    if (id !== expected.sessionId || id !== request.expected.sessionId || expected.storeId !== request.expected.storeId
      || expected.lifecycleId !== request.expected.lifecycleId || !this.admission.isRetired(id)) {
      this.refuse('native/maintenance-binding-changed', 'Native convergence requires the exact durable retirement binding.');
    }
    if ((this.operations.get(id) ?? 0) > 0 || (this.retained.get(id) ?? 0) > 0 || (this.followers.get(id) ?? 0) > 0) return false;
    this.assertCold(id);
    return this.admission.bypass(id, async () => {
      if (!await this.eraseCache(snapshot.cache, id, expected, request)) return false;
      this.query?._observations.cache.delete(id);
      const frozenIds = new Set(snapshot.workspaces.map(item => item.workspaceId));
      const convergeWorkspace = async () => {
        for (const [workspaceId, raw] of this.workspace.requireTable().entries()) {
          const record = workspaceRecord.parse(raw);
          if (!record.sessionIds.some(sessionId => sessionId === id)) continue;
          if (!frozenIds.has(workspaceId) || record.sessionIds.some(other => other !== id && this.workspace.sessionPaths.get(other) !== record.path)) return false;
          const entity = this.workspace.get(workspaceId);
          if (!entity) throw new Error('Native Workspace account lost its runtime entity.');
          await entity.detachSession(id);
        }
        const state = workspaceDomainState.parse(this.workspace.requireState());
        if (state.archivedSessionIds.includes(id as never) || state.pinnedSessionIds.includes(id as never)) {
          await this.workspace.setState({ ...state,
            archivedSessionIds: state.archivedSessionIds.filter(other => other !== id),
            pinnedSessionIds: state.pinnedSessionIds.filter(other => other !== id) });
        }
        this.workspace.headers.delete(id); this.workspace.sessionPaths.delete(id); this.workspace.invalidSessionPaths.delete(id);
        return true;
      };
      if (!await this.workspace.enqueueOperation(convergeWorkspace)) return false;
      if (this.query) {
        if (this.queryProvider === 'sqlite-0.2.0-rc.2') {
          await this.query.searchSessions({ query: 'native-retirement-reconciliation', limit: 1 });
        }
        if ((await this.query.listSessions()).some((record: ObjectPort) => record.header.id === id)) return false;
        this.assertInstances();
      }
      // This is a presentation edge only. Resource completion comes from the
      // owner journal and query/Workspace confirmations above.
      this.admission.withoutBypass(() => (this.ctx.emit as Method)('api-session/removed', id));
      return true;
    });
  }
}
