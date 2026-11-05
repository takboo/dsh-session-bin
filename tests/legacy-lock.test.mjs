import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, readdir, lstat, unlink, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { openNativeDeletionFixture } from './helpers/native-deletion-fixture.mjs';
import { NativeJsonlFiles } from '../dist/index.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createScratch, openFixture, transcript } from './helpers/fixture.mjs';
import { sessionBinPlugin, retainedLockEntries, assertCrashExit } from './helpers/platform-fixture.mjs';

async function legacyFixture(compression, { permanentDeletion = true } = {}) {
  const root = await createScratch('legacy-lock-');
  const f = await openFixture(root, { plugin: false, compression });
  const header = f.ctx.sessions.prepare(SessionId('historical'), { meta: { createdAt: 123 } }).header;
  const directory = join(root, 'logs', '_no-cwd', 'historical');
  await mkdir(directory, { recursive: true });
  // An independently written V0 artifact: no writer-open, migration or lock.
  const raw = { type: 'session', ...header, version: 0, delegationDepth: 0 };
  delete raw.isSeeded;
  const bytes = Buffer.from(JSON.stringify(raw) + '\n');
  const filename = `session.jsonl${compression === 'zstd' ? '.zstd' : ''}`;
  await writeFile(join(directory, filename), compression === 'zstd' ? zstdCompressSync(bytes) : bytes);
  await f.ctx.workspaceRegistry.archiveSession(SessionId('historical'));
  await f.mount(sessionBinPlugin(root), { coordinationDirectory: join(root, 'coordination'), permanentDeletion });
  return { ...f, service: f.ctx.get('sessionBin'), directory, filename, root };
}

for (const compression of ['none', 'zstd']) test(`explicit purge preparation adopts a lockless legacy log without migration (${compression})`, async () => {
  const f = await legacyFixture(compression);
  try {
    const path = join(f.directory, f.filename);
    const bytes = await readFile(path);
    const before = await lstat(path, { bigint: true });
    await f.service.list(); await f.service.reconcile();
    assert.deepEqual(await readdir(f.directory), [f.filename], 'startup and observation must not create coordination files');
    const plan = await f.service.preparePurge({ sessionId: 'historical' });
    assert.deepEqual(plan.blockers, []);
    assert(plan.binding); assert(plan.manifest);
    assert.deepEqual((await readdir(f.directory)).sort(), [f.filename, ...retainedLockEntries()].sort());
    assert.deepEqual(await readFile(path), bytes);
    const after = await lstat(path, { bigint: true });
    for (const field of ['ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field]);
    const lock = process.platform === 'win32' ? null : await lstat(join(f.directory, 'session.lock'), { bigint: true });
    const again = await f.service.preparePurge({ sessionId: 'historical' });
    assert.deepEqual(again.blockers, []);
    if (lock) assert.equal((await lstat(join(f.directory, 'session.lock'), { bigint: true })).ino, lock.ino);
    assert.equal((await f.service.executePurge(plan)).status, 'success');
    assert.deepEqual(await readdir(f.directory), retainedLockEntries());
    assert(!f.ctx.workspaceRegistry.archivedSessionIds.includes('historical'));
  } finally { await f.close(); }
});

const posix = process.platform !== 'win32';
for (const reason of ['active', 'unarchived', 'disabled']) test(`legacy coordination remains absent for ${reason} targets`, { skip: !posix }, async () => {
  const f = await legacyFixture('none', { permanentDeletion: reason !== 'disabled' });
  try {
    if (reason === 'active') f.state.activity.set('historical', ['turn']);
    if (reason === 'unarchived') await f.ctx.workspaceRegistry.unarchiveSession(SessionId('historical'));
    const plan = await f.service.preparePurge({ sessionId: 'historical' });
    assert(plan.blockers.length > 0);
    assert.deepEqual(await readdir(f.directory), [f.filename]);
  } finally { await f.close(); }
});

test('a previously bound legacy target never recreates a missing lock, including after reopen', { skip: !posix }, async () => {
  let f = await legacyFixture('none');
  const root = f.root; const directory = f.directory;
  try {
    const plan = await f.service.preparePurge({ sessionId: 'historical' });
    assert.deepEqual(plan.blockers, []);
    await unlink(join(directory, 'session.lock'));
    const blocked = await f.service.preparePurge({ sessionId: 'historical' });
    assert(blocked.blockers.some(row => row.code === 'jsonl/lock-missing'));
    await f.close();
    f = await openFixture(root, { plugin: true, legacy: false });
    const reopened = await f.ctx.get('sessionBin').preparePurge({ sessionId: 'historical' });
    assert(reopened.blockers.some(row => row.code === 'jsonl/lock-missing'));
    assert.deepEqual(await readdir(directory), ['session.jsonl']);
  } finally { await f.close(); }
});

for (const fault of ['current', 'staging', 'unknown', 'torn', 'duplicate', 'symlink', 'hardlink', 'nonempty-lock']) test(`legacy lock preparation refuses ${fault} resources without rewriting them`, { skip: !posix }, async () => {
  const f = await legacyFixture('none');
  try {
    const path = join(f.directory, f.filename);
    const bytes = await readFile(path);
    if (fault === 'current' || fault === 'staging') {
      const raw = { ...JSON.parse(bytes.toString()), version: 4, isSeeded: false };
      await writeFile(join(f.directory, fault === 'current' ? 'session.v4.jsonl' : 'session.v4.jsonl.123456abcdef.tmp'), JSON.stringify(raw) + '\n');
    }
    if (fault === 'unknown') await writeFile(join(f.directory, 'unknown-resource'), 'unique data');
    if (fault === 'torn') await writeFile(path, bytes.subarray(0, bytes.length - 1));
    if (fault === 'duplicate') {
      await mkdir(join(f.root, 'logs', 'duplicate', 'historical'), { recursive: true });
      await writeFile(join(f.root, 'logs', 'duplicate', 'historical', f.filename), bytes);
    }
    if (fault === 'symlink') await symlink(path, join(f.directory, 'session.lock'));
    if (fault === 'hardlink') await link(path, join(f.directory, 'session.lock'));
    if (fault === 'nonempty-lock') await writeFile(join(f.directory, 'session.lock'), 'must retain');
    const before = await readFile(path); const names = await readdir(f.directory);
    const files = await NativeJsonlFiles.open(f.ctx.sessionPersistence); assert(files);
    // The logical header is independent of this intentionally invalid medium.
    const header = { ...JSON.parse(bytes.toString()), version: 4, isSeeded: false };
    await assert.rejects(async () => {
      await files.prepareLegacyLock('historical', header);
      await files.inspect('historical', header);
    }, error => error.code?.startsWith('jsonl/'));
    assert.deepEqual(await readdir(f.directory), names);
    assert.deepEqual(await readFile(path), before);
    if (fault === 'nonempty-lock') assert.equal(await readFile(join(f.directory, 'session.lock'), 'utf8'), 'must retain');
  } finally { await f.close(); }
});

test('racing lock creation adopts the winning inode without truncation and preserves writer exclusion', { skip: !posix }, async () => {
  const f = await legacyFixture('none');
  let writer;
  try {
    const files = await NativeJsonlFiles.open(f.ctx.sessionPersistence); assert(files);
    const header = (await f.ctx.sessionPersistence.stat(SessionId('historical'))).header;
    const rows = files.rows.bind(files);
    let created = false;
    files.rows = async (...args) => {
      const result = await rows(...args);
      if (!created) {
        created = true;
        // The native writer wins between preflight and exclusive creation.
        writer = await f.ctx.sessionPersistence.open(SessionId('historical'), 'write');
      }
      return result;
    };
    await files.prepareLegacyLock('historical', header);
    const lock = await lstat(join(f.directory, 'session.lock'), { bigint: true });
    const inventory = await files.inspect('historical', header);
    await assert.rejects(files.acquire(inventory), error => error.code === 'jsonl/writer-active');
    await writer.close(); writer = undefined;
    const refreshed = await files.inspect('historical', header);
    const lease = await files.acquire(refreshed); await lease.release();
    assert.equal((await lstat(join(f.directory, 'session.lock'), { bigint: true })).ino, lock.ino);
  } finally { await writer?.close(); await f.close(); }
});

test('resource drift after exclusive lock creation refuses the candidate and retains coordination', { skip: !posix }, async () => {
  const f = await legacyFixture('none');
  try {
    const files = f.service.nativeOwner.files;
    const rows = files.rows.bind(files);
    let reads = 0;
    files.rows = async (...args) => {
      if (++reads === 2) await writeFile(join(f.directory, 'unexpected'), 'preserve unexpected resource');
      return rows(...args);
    };
    const plan = await f.service.preparePurge({ sessionId: 'historical' });
    assert(plan.blockers.some(row => row.code === 'jsonl/unknown-resource'));
    assert.equal(plan.binding, null);
    assert.equal(await readFile(join(f.directory, 'unexpected'), 'utf8'), 'preserve unexpected resource');
    assert.equal((await lstat(join(f.directory, 'session.lock'))).size, 0);
    assert(f.ctx.workspaceRegistry.archivedSessionIds.includes('historical'));
  } finally { await f.close(); }
});

test('unknown I/O after lock creation pauses deletion, preserves logs and recovers on a complete reopen', { skip: !posix }, async () => {
  let f = await legacyFixture('none');
  const root = f.root; const directory = f.directory;
  const path = join(directory, f.filename); const bytes = await readFile(path);
  try {
    const files = f.service.nativeOwner.files;
    const rows = files.rows.bind(files);
    let reads = 0;
    files.rows = async (...args) => {
      if (++reads === 2) throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' });
      return rows(...args);
    };
    await assert.rejects(f.service.preparePurge({ sessionId: 'historical' }));
    await assert.rejects(f.service.preparePurge({ sessionId: 'historical' }));
    assert.deepEqual(await readFile(path), bytes);
    const lock = await lstat(join(directory, 'session.lock'), { bigint: true });
    await f.close();
    f = await openFixture(root, { plugin: true, legacy: false });
    const service = f.ctx.get('sessionBin');
    const plan = await service.preparePurge({ sessionId: 'historical' });
    assert.deepEqual(plan.blockers, []);
    assert.equal((await lstat(join(directory, 'session.lock'), { bigint: true })).ino, lock.ino);
    assert.equal((await service.executePurge(plan)).status, 'success');
  } finally { await f.close(); }
});

test('process death after legacy lock creation preserves the inode and requires fresh explicit preparation', { skip: !posix, timeout: 20000 }, async () => {
  let f = await legacyFixture('zstd');
  const root = f.root; const directory = f.directory; const filename = f.filename;
  const bytes = await readFile(join(directory, filename));
  await f.close();
  const worker = fork(new URL('./helpers/legacy-lock-worker.mjs', import.meta.url), [root], { silent: true });
  let stderr = ''; let timedOut = false;
  worker.stdout.resume(); worker.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, 15000);
  try {
    const [code, signal] = await once(worker, 'exit');
    assert.equal(timedOut, false, stderr);
    assertCrashExit(root, 'legacy-lock-created', code, signal, stderr);
    const lock = await lstat(join(directory, 'session.lock'), { bigint: true });
    f = await openFixture(root, { plugin: true, legacy: false, compression: 'zstd' });
    const service = f.ctx.get('sessionBin');
    await service.list(); await service.reconcilePurge();
    assert.deepEqual(await readFile(join(directory, filename)), bytes);
    assert(f.ctx.workspaceRegistry.archivedSessionIds.includes('historical'));
    const plan = await service.preparePurge({ sessionId: 'historical' });
    assert.deepEqual(plan.blockers, []);
    assert.equal((await lstat(join(directory, 'session.lock'), { bigint: true })).ino, lock.ino);
    assert.equal((await service.executePurge(plan)).status, 'success');
  } finally { clearTimeout(timer); if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); await f.close(); }
});

for (const compression of ['none', 'zstd']) test(`legacy preparation deletes the complete cache and SQLite scope and retains sibling data (${compression})`, async () => {
  const f = await openNativeDeletionFixture(await createScratch('legacy-lock-indexes-'), { seed: true, compression, productService: true });
  try {
    const files = await NativeJsonlFiles.open(f.ctx.sessionPersistence); assert(files);
    const header = (await f.ctx.sessionPersistence.stat(SessionId('quiet'))).header;
    const inventory = await files.inspect('quiet', header);
    const directory = join(files.root, inventory.directory);
    for (const row of inventory.files) await unlink(join(directory, row.resourceId));
    if (posix) await unlink(join(directory, 'session.lock'));
    const raw = { type: 'session', ...header, version: 0, delegationDepth: 0 };
    delete raw.isSeeded;
    const bytes = Buffer.from(JSON.stringify(raw) + '\n');
    const filename = `session.jsonl${compression === 'zstd' ? '.zstd' : ''}`;
    await writeFile(join(directory, filename), compression === 'zstd' ? zstdCompressSync(bytes) : bytes);
    const sibling = await transcript(f, 'sibling');
    const cache = f.ctx.get('sessionProjectionCache'); const query = f.ctx.get('sessionQuery');
    assert(cache.requireTable().get('quiet'));
    assert(query._db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get('quiet'));
    const plan = await f.module.preparePurge({ sessionId: 'quiet' });
    assert.deepEqual(plan.blockers, []);
    assert(plan.manifest.resources.some(row => row.kind === 'cache'));
    assert(plan.manifest.resources.some(row => row.kind === 'index'));
    assert.equal((await f.module.executePurge(plan)).status, 'success');
    assert.equal(cache.requireTable().get('quiet'), undefined);
    assert.equal(query._db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get('quiet'), undefined);
    assert.equal(query._db.prepare('SELECT session_id FROM persisted_docs WHERE session_id = ?').get('quiet'), undefined);
    assert(!f.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    assert.deepEqual(await readdir(directory), retainedLockEntries());
    assert.deepEqual(await transcript(f, 'sibling'), sibling);
  } finally { await f.close(); }
});
