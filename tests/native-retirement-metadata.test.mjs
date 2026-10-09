import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { link, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createScratch, openFixture, workspaceRoot } from './helpers/fixture.mjs';
import { latch } from './helpers/retirement-owner.mjs';

const require = createRequire(import.meta.url);
const cliRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const sdkRequire = createRequire(cliRequire.resolve('@deepseek-ai/dsh-base/package.json'));
const load = async name => import(pathToFileURL(sdkRequire.resolve(name)).href);
const Projection = (await load('@deepseek-ai/dsh-session-projection')).default;
const Cache = (await load('@deepseek-ai/dsh-session-projection-cache')).default;
const Query = (await load('@deepseek-ai/dsh-session-query-sqlite')).default;
const artifactRoot = await createScratch('native-metadata-module-');
const compiled = await build({ entryPoints: [join(workspaceRoot, 'src/host/native-retirement-metadata.ts')], bundle: true,
  packages: 'external', platform: 'node', format: 'esm', write: false });
const artifact = join(artifactRoot, 'metadata.mjs');
await writeFile(artifact, compiled.outputFiles[0].text);
const { NativeMetadataAdapter, NativeMetadataRefusal, nativeMetadataSnapshotSchema } = await import(pathToFileURL(artifact).href);
const compiledAdmission = await build({ entryPoints: [join(workspaceRoot, 'src/host/native-retirement-admission.ts')], bundle: true,
  packages: 'external', platform: 'node', format: 'esm', write: false });
const admissionArtifact = join(artifactRoot, 'admission.mjs'); await writeFile(admissionArtifact, compiledAdmission.outputFiles[0].text);
const { NativeAdmission } = await import(pathToFileURL(admissionArtifact).href);
const compiledPersistence = await build({ entryPoints: [join(workspaceRoot, 'src/host/native-retirement-persistence.ts')], bundle: true,
  packages: 'external', platform: 'node', format: 'esm', write: false });
const persistenceArtifact = join(artifactRoot, 'persistence.mjs'); await writeFile(persistenceArtifact, compiledPersistence.outputFiles[0].text);
const { NativePersistenceAdapter } = await import(pathToFileURL(persistenceArtifact).href);

function admission() {
  const bypass = new AsyncLocalStorage(); const blocked = new Set(); const retired = new Set(); const tasks = new Map();
  const port = { blocked, retired,
    assertAllowed(id) { const token = bypass.getStore(); if (!(token?.active && token.id === id) && (blocked.has(id) || retired.has(id))) throw new NativeMetadataRefusal('native/fenced', 'fixture admission fenced'); },
    isRetired: id => retired.has(id), withoutBypass: work => bypass.run(undefined, work),
    bypass(id, work) {
      const token = { id, active: true };
      return bypass.run(token, () => {
        try {
          const result = work();
          if (result && typeof result.then === 'function') return result.finally(() => { token.active = false; });
          token.active = false; return result;
        } catch (error) { token.active = false; throw error; }
      });
    },
    trackGlobal: work => Promise.resolve().then(work),
    track(id, work) {
      port.assertAllowed(id);
      const promise = Promise.resolve().then(work); const set = tasks.get(id) ?? new Set(); set.add(promise); tasks.set(id, set);
      void promise.finally(() => { set.delete(promise); if (!set.size) tasks.delete(id); }).catch(() => {});
      return promise;
    },
    async drain(id) { while (tasks.has(id)) await Promise.allSettled([...tasks.get(id)]); },
  };
  return port;
}
async function fixture({ cache = false, query = false, realAdmission = false, queryOpenAt = 'startup', queryPath } = {}) {
  const root = await createScratch('native-metadata-');
  const f = await openFixture(root, { seed: true, plugin: false });
  try {
    if (cache) { await f.mount(Projection); await f.mount(Cache, { writeEveryEvents: 16, writeIntervalMs: 1000 }); }
    if (query) await f.mount(Query, { path: queryPath ?? join(root, 'query.sqlite'), openAt: queryOpenAt });
    await f.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
    const a = realAdmission ? new NativeAdmission() : admission(); if (realAdmission) a.activate();
    const adapter = await NativeMetadataAdapter.open(f.ctx, a); assert(adapter);
    const persistence = realAdmission ? new NativePersistenceAdapter(f.ctx.sessionPersistence, a) : undefined;
    const offPersistence = persistence?.install();
    const off = await adapter.install();
    let closed;
    return { ...f, a, adapter, close: () => closed ??= (async () => {
      try { await off(); await offPersistence?.(); } finally { await f.close(); }
    })() };
  } catch (error) { await f.close(); throw error; }
}
const expected = { storeId: 'fixture-metadata-store', sessionId: 'quiet', lifecycleId: 'fixture-exact-lifecycle' };
const request = { operationId: 'fixture-metadata-retirement', expected,
  bin: { kind: 'native-archive', entryId: '014b1454-7c31-4a7b-8465-aa97da95ad61', entryVersion: 2 }, manifestDigest: 'a'.repeat(64) };
function retire(f) { f.a.blocked.add('quiet'); f.a.retired.add('quiet'); }
function hideErasedPersistence(f) {
  // This participant does not own native transcript files. The file owner is
  // independently tested; hide its retired target only through the fixture
  // persistence face to exercise actual query-owned index reconciliation.
  const persistence = f.ctx.sessionPersistence;
  const list = persistence.list.bind(persistence); const stat = persistence.stat.bind(persistence);
  persistence.list = async options => (await list(options)).filter(item => item.header.id !== 'quiet');
  persistence.stat = async (id, options) => id === 'quiet' ? undefined : stat(id, options);
  return () => { persistence.list = list; persistence.stat = stat; };
}

test('metadata schema continues to parse cache snapshots without Windows physical identity', async () => {
  const f = await fixture({ cache: true });
  try {
    const snapshot = await f.adapter.capture('quiet');
    const legacy = structuredClone(snapshot); delete legacy.cache.physicalIdentity;
    assert.deepEqual(nativeMetadataSnapshotSchema.parse(legacy), legacy);
  } finally { await f.close(); }
});

test('every platform refuses the retained whole-unit source that can bootstrap the last cache document again', async () => {
  const f = await fixture({ cache: true });
  try {
    const cache = f.ctx.get('sessionProjectionCache');
    const handle = await f.ctx.sessionPersistence.open(SessionId('quiet'), 'read');
    try { const log = await handle.read(); cache.coldSnapshot(handle.header, handle.inheritedEventCount, log.events); }
    finally { await handle.close(); }
    const table = cache.requireTable(); await table.host.enqueue(async () => undefined);
    const payload = structuredClone(table.get('quiet')); assert(payload);
    const document = join(table.host.unit.tableDir('sessions'), 'quiet.json');
    const before = await readFile(document);
    const legacyPath = join(dirname(table.host.unit.dir), 'session_projcache.json');
    const legacy = JSON.stringify({ unit: { name: 'session_projcache', version: 7 }, tables: { sessions: { quiet: payload } } });
    await writeFile(legacyPath, legacy, { flag: 'wx', flush: true });
    await assert.rejects(f.adapter.capture('quiet'), error => error.code === 'native/cache-unclassified-resource');
    assert.deepEqual(await readFile(document), before); assert.equal(await readFile(legacyPath, 'utf8'), legacy);
    assert(f.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    // Only this temporary fixture removes its medium document: demonstrate the
    // actual source which ordinary deletion must refuse, not a synthetic replay.
    await table.host.unit.deleteRecord('sessions', 'quiet');
    const reopened = await table.host.unit.loadAll();
    assert.deepEqual(reopened.tables.sessions.quiet, payload);
    assert.equal(await readFile(legacyPath, 'utf8'), legacy, 'The SDK retains the bootstrap source.');
    assert(await readFile(document), 'The real SDK republishes the last per-record document.');
  } finally { await f.close(); }
});

test('native metadata convergence removes only frozen target membership/global/index maps and preserves unrelated current changes', async () => {
  const f = await fixture();
  try {
    const snapshot = await f.adapter.capture('quiet'); assert(snapshot.global.archived); assert.equal(snapshot.workspaces.length, 1);
    const workspace = f.ctx.workspaceRegistry.list()[0];
    await workspace.setTitle('title changed after preparation');
    await f.ctx.workspaceRegistry.archiveSession(SessionId('sibling'));
    retire(f);
    assert.equal(await f.adapter.converge(snapshot, expected, request), true);
    assert(!workspace.sessionIds.includes('quiet')); assert(workspace.sessionIds.includes('sibling'));
    assert.equal(workspace.title, 'title changed after preparation');
    assert.deepEqual([...f.ctx.workspaceRegistry.archivedSessionIds], ['sibling']);
    for (const field of ['headers', 'sessionPaths', 'invalidSessionPaths']) assert(!f.ctx.workspaceRegistry[field].has('quiet'));
    assert.equal(await f.adapter.converge(snapshot, expected, request), true, 'same saved snapshot recovery is idempotent');
    await assert.rejects(async () => f.ctx.workspaceRegistry.unarchiveSession(SessionId('quiet')), /fenced/);
    assert.throws(() => f.ctx.sessions.prepare(SessionId('quiet')), /fenced/);
  } finally { await f.close(); }
});

test('native archive mutation queued before fencing rechecks admission in its real queue slot', { timeout: 15000 }, async () => {
  const f = await fixture(); const gate = latch(); let blocker; let mutation;
  try {
    blocker = f.ctx.workspaceRegistry.enqueueOperation(() => gate.pause()); await gate.entered;
    mutation = f.ctx.workspaceRegistry.unarchiveSession(SessionId('quiet'));
    void mutation.catch(() => {}); retire(f); gate.release(); await blocker;
    await assert.rejects(mutation, /fenced/);
    assert(f.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
  } finally { gate.release(); await blocker; await mutation?.catch(() => {}); await f.close(); }
});

test('capture refuses live, activity, and unrelated filtered Workspace candidates without modifying metadata', async () => {
  const f = await fixture();
  try {
    f.state.activity.set('quiet', ['turn']); await assert.rejects(f.adapter.capture('quiet'), error => error.code === 'native/session-active');
    f.state.activity.delete('quiet');
    const live = f.ctx.sessions.prepare(SessionId('quiet')); const detach = f.ctx.sessions.enter(live);
    await assert.rejects(f.adapter.capture('quiet'), error => error.code === 'native/session-live'); detach();
    const registry = f.ctx.workspaceRegistry; registry.sessionPaths.delete('sibling');
    await assert.rejects(f.adapter.capture('quiet'), error => error.code === 'native/workspace-pruning-required');
    assert(registry.requireTable().entries().next().value[1].sessionIds.includes('quiet'));
  } finally { await f.close(); }
});

test('projection cache private put gate covers cold write-back and target row deletion without collateral erasure', async () => {
  const f = await fixture({ cache: true });
  try {
    const cache = f.ctx.get('sessionProjectionCache');
    for (const id of ['quiet', 'sibling']) {
      const handle = await f.ctx.sessionPersistence.open(SessionId(id), 'read');
      try { const log = await handle.read(); cache.coldSnapshot(handle.header, handle.inheritedEventCount, log.events); }
      finally { await handle.close(); }
      await f.a.drain(id);
    }
    const snapshot = await f.adapter.capture('quiet'); assert(snapshot.cache.present);
    const sibling = structuredClone(cache.requireTable().get('sibling'));
    retire(f);
    await assert.rejects(async () => cache.put('quiet', {}, {}), /fenced/);
    assert.equal(await f.adapter.converge(snapshot, expected, request), true);
    assert.equal(cache.requireTable().get('quiet'), undefined);
    assert.deepEqual(cache.requireTable().get('sibling'), sibling);
    assert.throws(() => cache.coldSnapshot({ id: 'quiet' }, 0, []), /fenced/);
  } finally { await f.close(); }
});

test('actual SQLite owner reconciliation removes target persisted rows and prepared cache after certified source retirement', async () => {
  const f = await fixture({ cache: true, query: true }); let restore;
  try {
    const query = f.ctx.get('sessionQuery');
    await query.searchSessions({ query: 'completed', limit: 1 });
    assert(query._db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get('quiet'));
    const observation = await query.observeSession(SessionId('quiet'), { projectionMode: 'none' });
    await assert.rejects(f.adapter.capture('quiet'), error => error.code === 'native/query-retained');
    const kept = observation.retain(); observation[Symbol.dispose]();
    await assert.rejects(f.adapter.capture('quiet'), error => error.code === 'native/query-retained'); kept[Symbol.dispose]();
    const snapshot = await f.adapter.capture('quiet'); assert.equal(snapshot.queryProvider, 'sqlite-0.2.0-rc.2');
    restore = hideErasedPersistence(f); retire(f);
    assert.equal(await f.adapter.converge(snapshot, expected, request), true);
    assert.equal(query._observations.cache.has('quiet'), false);
    assert.equal(query._db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get('quiet'), undefined);
    assert.equal(query._db.prepare('SELECT session_id FROM persisted_docs WHERE session_id = ?').get('quiet'), undefined);
    assert(query._db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get('sibling'));
    assert(!(await query.listSessions()).some(item => item.header.id === 'quiet'));
    await assert.rejects(async () => query.observeSession(SessionId('quiet')), /fenced/);
  } finally { restore?.(); await f.close(); }
});

test('cache row scope drift returns known pending instead of deleting a newly published checkpoint', async () => {
  const f = await fixture({ cache: true });
  try {
    const snapshot = await f.adapter.capture('quiet'); assert.equal(snapshot.cache.present, false);
    const cache = f.ctx.get('sessionProjectionCache'); const handle = await f.ctx.sessionPersistence.open(SessionId('quiet'), 'read');
    try { const log = await handle.read(); cache.coldSnapshot(handle.header, handle.inheritedEventCount, log.events); }
    finally { await handle.close(); }
    await f.a.drain('quiet'); retire(f);
    assert.equal(await f.adapter.converge(snapshot, expected, request), false);
    assert(cache.requireTable().get('quiet')); assert(f.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
  } finally { await f.close(); }
});

test('instance guard preserves the original Cordis caller fiber lifetime for SessionStore.create', async () => {
  const f = await fixture();
  try {
    const fiber = await f.mount({ name: 'native-metadata-caller-scope', inject: ['sessions'], apply(ctx) {
      ctx.sessions.create(SessionId('scoped-metadata-session'));
    } });
    assert(f.ctx.sessions.get(SessionId('scoped-metadata-session')));
    await fiber.dispose();
    assert.equal(f.ctx.sessions.get(SessionId('scoped-metadata-session')), undefined);
  } finally { await f.close(); }
});

test('frozen SQLite provider path cannot drift under an unchanged service object', async () => {
  const f = await fixture({ query: true });
  try {
    const query = f.ctx.get('sessionQuery'); const path = query.config.path;
    const snapshot = await f.adapter.capture('quiet'); assert.equal(snapshot.queryPath, path);
    query.config.path = join(f.root, 'other-index.sqlite');
    await assert.rejects(f.adapter.capture('quiet'), error => error.code === 'native/composition-changed');
    query.config.path = path;
  } finally { await f.close(); }
});

test('projection cache capture refuses a real hardlinked document through descriptor identity', async () => {
  const f = await fixture({ cache: true });
  try {
    const table = f.ctx.get('sessionProjectionCache').requireTable();
    const row = { identity: { formatVersion: 4, createdAt: 10000, cwd: join(f.root, 'workspace'), isSeeded: false, inheritedEventCount: 0 }, rows: {} };
    await table.put('quiet', row);
    const document = join(table.host.unit.tableDir('sessions'), 'quiet.json');
    const alias = join(table.host.unit.tableDir('sessions'), 'quiet-hardlink');
    await link(document, alias);
    await assert.rejects(f.adapter.capture('quiet'), error => error.code === 'native/cache-unsafe-document');
  } finally { await f.close(); }
});

test('cache medium commit with lost put acknowledgement cannot hide a payload behind absent memory', async () => {
  const f = await fixture({ cache: true });
  try {
    const cache = f.ctx.get('sessionProjectionCache'); const table = cache.requireTable(); const unit = table.host.unit;
    const put = unit.putRecord; const row = { identity: { formatVersion: 4, createdAt: 10000, cwd: join(f.root, 'workspace'), isSeeded: false, inheritedEventCount: 0 }, rows: {} };
    unit.putRecord = async function (...args) { await put.apply(this, args); throw new Error('cache put acknowledgement lost'); };
    await assert.rejects(table.put('quiet', row), /acknowledgement lost/); unit.putRecord = put;
    assert.equal(table.get('quiet'), undefined);
    assert((await unit.loadAll()).tables.sessions.quiet, 'the actual backend medium contains the committed payload');
    const snapshot = await f.adapter.capture('quiet'); assert.equal(snapshot.cache.present, true);
    assert.equal(snapshot.cache.memoryDigest, null); assert(snapshot.cache.documentDigest);
    retire(f);
    assert.equal(await f.adapter.converge(snapshot, expected, request), true);
    assert.equal((await unit.loadAll()).tables.sessions.quiet, undefined); assert.equal(table.get('quiet'), undefined);
    assert.equal(await f.adapter.converge(snapshot, expected, request), true);
  } finally { await f.close(); }
});

test('lost cache delete acknowledgement reuses the frozen medium scope and clears stale memory', async () => {
  const f = await fixture({ cache: true });
  try {
    const cache = f.ctx.get('sessionProjectionCache'); const table = cache.requireTable(); const unit = table.host.unit;
    const row = { identity: { formatVersion: 4, createdAt: 10000, cwd: join(f.root, 'workspace'), isSeeded: false, inheritedEventCount: 0 }, rows: {} };
    await table.put('quiet', row); const snapshot = await f.adapter.capture('quiet'); const remove = unit.deleteRecord;
    unit.deleteRecord = async function (...args) { await remove.apply(this, args); throw new Error('cache delete acknowledgement lost'); };
    retire(f); await assert.rejects(f.adapter.converge(snapshot, expected, request), /acknowledgement lost/);
    unit.deleteRecord = remove; assert(table.get('quiet')); assert.equal((await unit.loadAll()).tables.sessions.quiet, undefined);
    assert.equal(await f.adapter.converge(snapshot, expected, request), true); assert.equal(table.get('quiet'), undefined);
  } finally { await f.close(); }
});

test('projection cache deletion observers cannot inherit native maintenance permission', async () => {
  const f = await fixture({ cache: true }); let observed = false; let delayed;
  try {
    const table = f.ctx.get('sessionProjectionCache').requireTable();
    const row = { identity: { formatVersion: 4, createdAt: 10000, cwd: join(f.root, 'workspace'), isSeeded: false, inheritedEventCount: 0 }, rows: {} };
    await table.put('quiet', row);
    const snapshot = await f.adapter.capture('quiet');
    const off = f.ctx.on('domain/changed', change => {
      if (change.domain !== 'session_projcache' || change.table !== 'sessions' || change.key !== 'quiet' || change.operation !== 'deleted') return;
      observed = true;
      assert.throws(() => f.ctx.sessions.prepare(SessionId('quiet')), /fenced/);
      delayed = Promise.resolve().then(() => assert.throws(() => f.ctx.sessions.prepare(SessionId('quiet')), /fenced/));
    });
    retire(f); assert.equal(await f.adapter.converge(snapshot, expected, request), true);
    await delayed; off(); assert.equal(observed, true);
  } finally { await delayed; await f.close(); }
});

test('ordinary domain observers cannot synchronously or later reuse native maintenance permission', async () => {
  const f = await fixture(); const gate = latch(); let delayed;
  try {
    const snapshot = await f.adapter.capture('quiet');
    const off = f.ctx.on('domain/changed', change => {
      if (change.domain !== 'workspace' || change.table !== '' || change.value.archivedSessionIds.includes('quiet')) return;
      assert.throws(() => f.ctx.sessions.prepare(SessionId('quiet')), /fenced/);
      delayed = gate.pause().then(() => { assert.throws(() => f.ctx.sessions.prepare(SessionId('quiet')), /fenced/); });
    });
    retire(f); assert.equal(await f.adapter.converge(snapshot, expected, request), true);
    await gate.entered; gate.release(); await delayed; off();
  } finally { gate.release(); await delayed; await f.close(); }
});

test('trusted forceRestore revokes old method aliases while the replacement retains durable SID protection', async () => {
  const f = await fixture();
  try {
    const oldPrepare = f.ctx.sessions.prepare; const snapshot = await f.adapter.capture('quiet'); retire(f);
    await f.adapter.converge(snapshot, expected, request); f.adapter.forceRestore();
    const next = await NativeMetadataAdapter.open(f.ctx, f.a); assert(next); const off = await next.install();
    try {
      assert.throws(() => oldPrepare.call(f.ctx.sessions, SessionId('sibling')), error => error.code === 'native/stale-reference');
      assert.throws(() => f.ctx.sessions.prepare(SessionId('quiet')), /fenced/);
      assert(f.ctx.sessions.prepare(SessionId('fresh-after-takeover')));
    } finally { await off(); next.forceRestore(); }
  } finally { await f.close(); }
});

test('whole point query read is registered globally before same-tick native scope acquisition', { timeout: 15000 }, async () => {
  const f = await fixture({ query: true, realAdmission: true }); let release;
  try {
    const query = f.ctx.get('sessionQuery');
    const reading = query.readSession(SessionId('quiet'));
    const acquisition = f.a.acquire('quiet');
    assert.equal((await reading).session.id, 'quiet');
    release = await acquisition;
    assert.equal(f.ctx.sessions.get(SessionId('quiet')), undefined);
  } finally { release?.(); await f.close(); }
});

test('a complete admitted SQLite queue request drains before an acquiring native scope', { timeout: 15000 }, async () => {
  const f = await fixture({ query: true, realAdmission: true }); const gate = latch(); let release; let searching; let acquiring;
  const provider = f.ctx.sessionPersistence[Symbol.for('cordis.original')]; const list = provider.list; let paused = false;
  provider.list = async function (...args) {
    const result = await list.apply(this, args);
    if (!paused) { paused = true; await gate.pause(); }
    return result;
  };
  try {
    searching = f.ctx.get('sessionQuery').searchSessions({ query: 'completed', limit: 1 });
    await gate.entered; let acquired = false;
    acquiring = f.a.acquire('quiet').then(value => { acquired = true; return value; });
    await new Promise(done => setImmediate(done)); assert.equal(acquired, false);
    gate.release(); await searching; release = await acquiring;
    assert.equal(acquired, true);
  } finally {
    gate.release(); await searching; release ??= await acquiring; release?.(); provider.list = list; await f.close();
  }
});

test('Workspace header lookup and index writes keep their complete accepted read frame through scope contention', { timeout: 15000 }, async () => {
  const f = await fixture({ realAdmission: true }); let release;
  try {
    const registry = f.ctx.workspaceRegistry; const header = registry.headers.get('quiet');
    const indexing = registry.indexHeader(header);
    const lookup = registry.readSessionHeader(SessionId('quiet'));
    const acquisition = f.a.acquire('quiet');
    await indexing; assert.equal((await lookup).id, 'quiet'); release = await acquisition;
    assert(registry.sessionPaths.has('quiet'));
  } finally { release?.(); await f.close(); }
});

test('official disabled-memory query retires generic metadata without opening a SQLite index', async () => {
  const f = await fixture({ cache: true, query: true, queryOpenAt: 'never', queryPath: ':memory:' }); let restore;
  try {
    const query = f.ctx.get('sessionQuery');
    assert.equal(query._db, undefined); assert.equal(query._ready, undefined);
    const observation = await query.observeSession(SessionId('quiet'), { projectionMode: 'none' });
    await assert.rejects(f.adapter.capture('quiet'), error => error.code === 'native/query-retained'); observation[Symbol.dispose]();
    const snapshot = await f.adapter.capture('quiet');
    assert.equal(snapshot.queryProvider, 'sqlite-memory-disabled-0.2.0-rc.2'); assert.equal(snapshot.queryPath, ':memory:');
    restore = hideErasedPersistence(f); retire(f);
    assert.equal(await f.adapter.converge(snapshot, expected, request), true);
    assert.equal(query._observations.cache.has('quiet'), false);
    assert(!(await query.listSessions()).some(item => item.header.id === 'quiet'));
    assert.equal(query._db, undefined); assert.equal(query._ready, undefined);
    await assert.rejects(async () => query.observeSession(SessionId('quiet')), /fenced/);
  } finally { restore?.(); await f.close(); }
});

test('disabled query with a durable index path remains unqualified', async () => {
  const root = await createScratch('native-metadata-disabled-durable-');
  const f = await openFixture(root, { seed: true, plugin: false });
  try {
    await f.mount(Query, { path: join(root, 'possibly-historical-index.sqlite'), openAt: 'never' });
    assert.equal(await NativeMetadataAdapter.open(f.ctx, admission()), undefined);
  } finally { await f.close(); }
});

for (const field of ['_db', '_ready']) test(`disabled-memory query ${field} initialization is a conflict instead of expanding the old scope`, async () => {
  const f = await fixture({ query: true, queryOpenAt: 'never', queryPath: ':memory:' });
  try {
    const query = f.ctx.get('sessionQuery'); const snapshot = await f.adapter.capture('quiet');
    query[field] = field === '_db' ? { unexpected: true } : Promise.resolve();
    await assert.rejects(f.adapter.capture('quiet'), error => error.code === 'native/composition-changed');
    retire(f); await assert.rejects(f.adapter.converge(snapshot, expected, request), error => error.code === 'native/composition-changed');
    query[field] = undefined;
  } finally { await f.close(); }
});

test('disabled-memory whole-query read drains under same-tick native scope acquisition without opening SQLite', { timeout: 15000 }, async () => {
  const f = await fixture({ query: true, queryOpenAt: 'never', queryPath: ':memory:', realAdmission: true }); let release;
  try {
    const query = f.ctx.get('sessionQuery');
    const reading = query.readSession(SessionId('quiet')); const acquisition = f.a.acquire('quiet');
    assert.equal((await reading).session.id, 'quiet'); release = await acquisition;
    assert.equal(query._db, undefined); assert.equal(query._ready, undefined);
  } finally { release?.(); await f.close(); }
});

test('metadata close restores ordinary instance methods but leaves durable retired targets fenced', async () => {
  const f = await fixture();
  const snapshot = await f.adapter.capture('quiet'); const sessions = f.ctx.sessions; retire(f);
  await f.adapter.converge(snapshot, expected, request); await f.close();
  assert.throws(() => sessions.prepare(SessionId('quiet')), /retired/);
});
