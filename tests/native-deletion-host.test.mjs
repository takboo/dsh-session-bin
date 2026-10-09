import assert from 'node:assert/strict';
import { test } from 'node:test';
import { open as openFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as product from '../dist/index.js';
import { openNativeDeletionFixture } from './helpers/native-deletion-fixture.mjs';
import { createScratch, openFixture, transcript } from './helpers/fixture.mjs';
import { assertStableSessionLock, retainedLockEntries, sessionBinPlugin } from './helpers/platform-fixture.mjs';

for (const compression of ['none', 'zstd']) test(`real native deletion joins cache and SQLite owner erasure and survives reopen (${compression})`, { timeout: 20000 }, async t => {
  const root = await createScratch(`native-delete-complete-${compression}-`); t.diagnostic(root);
  let fixture = await openNativeDeletionFixture(root, { seed: true, compression, productService: true });
  let plan; let result;
  try {
    const query = fixture.ctx.get('sessionQuery'); const cache = fixture.ctx.get('sessionProjectionCache');
    assert(query._db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get('quiet'));
    assert(cache.requireTable().get('quiet'));
    const sibling = await transcript(fixture, 'sibling');
    plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert.deepEqual(plan.blockers, []);
    assert(plan.manifest.resources.some(row => row.kind === 'cache')); assert(plan.manifest.resources.some(row => row.kind === 'index'));
    result = await fixture.module.executePurge(plan);
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(cache.requireTable().get('quiet'), undefined);
    assert.equal(query._db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get('quiet'), undefined);
    assert.equal(query._db.prepare('SELECT session_id FROM persisted_docs WHERE session_id = ?').get('quiet'), undefined);
    assert(query._db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get('sibling'));
    assert(!(await query.listSessions()).some(item => item.header?.id === 'quiet' || item.id === 'quiet'));
    await fixture.close(); fixture = await openNativeDeletionFixture(root, { compression, productService: true });
    assert.deepEqual(await fixture.module.executePurge(plan), result);
    assert.equal(await fixture.ctx.sessionPersistence.stat(SessionId('quiet')), undefined);
    assert.equal(fixture.ctx.get('sessionProjectionCache').requireTable().get('quiet'), undefined);
    assert.equal(fixture.ctx.get('sessionQuery')._db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get('quiet'), undefined);
    assert.deepEqual(await transcript(fixture, 'sibling'), sibling);
  } finally { await fixture.close(); }
});

test('real NativeOwner serializes concurrent lifecycle observations and keeps known missing recovery refusal healthy', { timeout: 20000 }, async () => {
  const fixture = await openNativeDeletionFixture(await createScratch('native-delete-control-plane-'), { seed: true });
  try {
    const keys = await Promise.all(Array.from({ length: 4 }, () => fixture.nativeOwner.inspect('quiet')));
    for (const key of keys) assert.deepEqual(key, keys[0]);
    await assert.rejects(fixture.nativeOwner.recover('unknown-owner-operation'));
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' }); assert.deepEqual(plan.blockers, []);
    assert.equal((await fixture.module.executePurge(plan)).status, 'success');
  } finally { await fixture.close(); }
});

test('same SDK instance reactivation can continue a trusted fenced native deletion while stale guard aliases stay revoked', { timeout: 20000 }, async () => {
  const root = await createScratch('native-delete-same-instance-');
  const fixture = await openNativeDeletionFixture(root, { seed: true, productService: true });
  let fiber;
  try {
    const service = fixture.ctx.get('sessionBin');
    service.nativeOwner.coordinator.options.canAdvance = () => false;
    const plan = await service.preparePurge({ sessionId: 'quiet' });
    assert.equal((await service.executePurge(plan)).status, 'pending-recovery');
    const stalePrepare = fixture.ctx.sessions.prepare.bind(fixture.ctx.sessions);
    await fixture.productFiber.dispose();
    fiber = await fixture.mount(sessionBinPlugin(root), { coordinationDirectory: join(root, 'coordination') });
    const next = fixture.ctx.get('sessionBin');
    assert.equal((await next.getPurgeOperation(plan.operationId)).result.status, 'success');
    assert.equal(await fixture.ctx.sessionPersistence.stat(SessionId('quiet')), undefined);
    assert.throws(() => stalePrepare(SessionId('quiet')));
    assert(fixture.ctx.sessions.prepare(SessionId('fresh-after-handoff')));
  } finally { await fiber?.dispose(); await fixture.close(); }
});

test('official default Web never-memory query mode deletes real logs and cache without enabling or opening SQLite', { timeout: 20000 }, async t => {
  const root = await createScratch('native-delete-default-web-'); t.diagnostic(root);
  const fixture = await openNativeDeletionFixture(root, { seed: true, productService: true, queryMode: 'disabled-memory' });
  try {
    const query = fixture.ctx.get('sessionQuery');
    assert.equal(query.config.openAt, 'never'); assert.equal(query._db, undefined); assert.equal(query._ready, undefined);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' }); assert.deepEqual(plan.blockers, []);
    assert(!plan.manifest.resources.some(resource => resource.kind === 'index'));
    assert.equal((await fixture.module.executePurge(plan)).status, 'success');
    assert.equal(query.config.openAt, 'never'); assert.equal(query._db, undefined); assert.equal(query._ready, undefined);
    assert.equal(await fixture.ctx.sessionPersistence.stat(SessionId('quiet')), undefined);
    assert.equal(fixture.ctx.get('sessionProjectionCache').requireTable().get('quiet'), undefined);
    assert(!(await query.listSessions()).some(item => item.header?.id === 'quiet' || item.id === 'quiet'));
  } finally { await fixture.close(); }
});

if (process.platform === 'win32') test('Windows missing JSONL header cannot be admitted or prepared for deletion', { timeout: 20000 }, async () => {
  const fixture = await openNativeDeletionFixture(await createScratch('native-delete-missing-header-'), { seed: true });
  try {
    const sibling = await transcript(fixture, 'sibling');
    const files = await product.NativeJsonlFiles.open(fixture.ctx.sessionPersistence); assert(files);
    const header = (await fixture.ctx.sessionPersistence.stat(SessionId('quiet'))).header;
    const inventory = await files.inspect('quiet', header);
    const path = join(files.root, inventory.directory, inventory.files[0].resourceId);
    const handle = await openFile(path, 'r+');
    try { await handle.truncate(0); await handle.sync(); } finally { await handle.close(); }
    await assert.rejects(files.inspect('quiet', header), error => error.code === 'jsonl/header-invalid');
    assert.equal(await fixture.ctx.sessionPersistence.stat(SessionId('quiet')), undefined);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert.equal(plan.binding, null); assert.equal(plan.manifest, null);
    assert.deepEqual(plan.blockers, [{ code: 'session-not-found' }]);
    assert.equal((await fixture.module.executePurge(plan)).status, 'rejected');
    assert.equal((await readFile(path)).length, 0);
    assert.deepEqual(await transcript(fixture, 'sibling'), sibling);
  } finally { await fixture.close(); }
});

const archive = fixture => fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));

test('production single delete erases real JSONL bytes and converges native membership while retaining sibling and stable lock', { timeout: 20000 }, async t => {
  const root = await createScratch('native-delete-real-'); t.diagnostic(root);
  let fixture = await openFixture(root, { seed: true, legacy: false });
  let result; let plan;
  try {
    const sibling = await transcript(fixture, 'sibling');
    await archive(fixture);
    const files = await product.NativeJsonlFiles.open(fixture.ctx.sessionPersistence);
    assert(files);
    const header = (await fixture.ctx.sessionPersistence.stat(SessionId('quiet'))).header;
    const inventory = await files.inspect('quiet', header);
    const directory = join(files.root, inventory.directory);
    const lockPath = join(directory, 'session.lock');
    const beforeLock = await assertStableSessionLock(directory);
    if (process.platform === 'win32') {
      assert.deepEqual(inventory.lock, { kind: 'win32-semaphore', name: product.windowsSemaphoreName(lockPath, 'session') });
    }
    plan = await fixture.bin.preparePurge({ sessionId: 'quiet' });
    assert.deepEqual(plan.blockers, [], JSON.stringify(plan.blockers));
    assert.equal(plan.schemaVersion, 2); assert(plan.binding && plan.manifest);
    result = await fixture.bin.executePurge(plan);
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.ownerState.phase, 'done');
    assert.equal(await fixture.ctx.sessionPersistence.stat(SessionId('quiet')), undefined);
    assert(!(await fixture.ctx.sessionPersistence.list()).some(item => item.header.id === 'quiet'));
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    assert(!fixture.ctx.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes('quiet')));
    assert.deepEqual(await readdir(directory), retainedLockEntries());
    await assertStableSessionLock(directory, beforeLock);
    assert.deepEqual(await transcript(fixture, 'sibling'), sibling);
    assert.deepEqual(await fixture.bin.executePurge(plan), result);
    await fixture.close(); fixture = await openFixture(root, { legacy: false });
    assert.deepEqual(await fixture.bin.executePurge(plan), result);
    assert.equal(await fixture.ctx.sessionPersistence.stat(SessionId('quiet')), undefined);
    assert.deepEqual(await transcript(fixture, 'sibling'), sibling);
    assert.deepEqual(await fixture.bin.list(), []);
  } finally { await fixture.close(); }
});

test('native deletion refuses active and retained raw handles without changing bytes or pausing the plugin', { timeout: 20000 }, async () => {
  const fixture = await openFixture(await createScratch('native-delete-held-'), { seed: true, legacy: false });
  let handle;
  try {
    await archive(fixture);
    fixture.state.activity.set('quiet', ['turn']);
    const active = await fixture.bin.preparePurge({ sessionId: 'quiet' });
    assert(active.blockers.length); assert.equal((await fixture.bin.executePurge(active)).status, 'rejected');
    fixture.state.activity.delete('quiet');
    handle = await fixture.ctx.sessionPersistence.open(SessionId('quiet'), 'read');
    const held = await fixture.bin.preparePurge({ sessionId: 'quiet' });
    assert(held.blockers.some(item => item.code === 'native/persistence-retained'));
    assert.equal((await fixture.bin.executePurge(held)).status, 'rejected');
    assert((await handle.read()).events.length);
    await handle.close(); handle = undefined;
    const ready = await fixture.bin.preparePurge({ sessionId: 'quiet' });
    assert.deepEqual(ready.blockers, []);
    assert.equal((await fixture.bin.executePurge(ready)).status, 'success');
  } finally { await handle?.close(); await fixture.close(); }
});
