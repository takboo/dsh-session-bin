import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, readdir, lstat, link, symlink, open as openFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { SessionId } from '@deepseek-ai/dsh-session';
import { NativeJsonlFiles, nativeJsonlInventorySchema, nativeJsonlFileSchema } from '../dist/index.js';
import { createScratch, openFixture, transcript } from './helpers/fixture.mjs';
import { assertStableSessionLock, retainedLockEntries } from './helpers/platform-fixture.mjs';

async function open(compression = 'none') {
  const root = await createScratch('native-jsonl-files-');
  const fixture = await openFixture(root, { seed: true, plugin: false, compression });
  const files = await NativeJsonlFiles.open(fixture.ctx.sessionPersistence);
  assert(files);
  const snapshot = await fixture.ctx.sessionPersistence.stat(SessionId('quiet'));
  const header = snapshot.header;
  const inventory = await files.inspect('quiet', header);
  return { ...fixture, files, header, inventory, directory: join(files.root, inventory.directory), compression };
}
function refused(code) { return error => error.code === code; }
function physicalHeader(header, version = 4) {
  const value = { type: 'session', ...header, version, delegationDepth: header.delegationDepth ?? 0 };
  if (version < 2) { delete value.isSeeded; if (header.isSeeded) value.seedLength = 0; }
  return Buffer.from(`${JSON.stringify(value)}\n`);
}
async function seedGeneration(fixture, version, name) {
  const suffix = fixture.compression === 'none' ? '.jsonl' : '.jsonl.zstd';
  const filename = name ?? (version === 0 ? `session${suffix}` : `session.v${version}${suffix}`);
  const raw = physicalHeader(fixture.header, version);
  await writeFile(join(fixture.directory, filename), fixture.compression === 'none' ? raw : zstdCompressSync(raw), { flag: 'wx', mode: 0o600 });
  return filename;
}
async function writerProbe(fixture) {
  const worker = fork(new URL('./helpers/persistence-worker.mjs', import.meta.url), [fixture.root, fixture.compression, 'quiet'], { silent: true });
  let reply; let stderr = ''; let expired = false;
  worker.stdout.resume(); worker.stderr.on('data', value => { stderr += value; }); worker.on('message', value => { reply = value; });
  const deadline = setTimeout(() => { expired = true; worker.kill('SIGKILL'); }, 15000);
  try {
    const [code, signal] = await once(worker, 'exit');
    assert.equal(expired, false, stderr); assert.equal(code, 0, stderr); assert.equal(signal, null, stderr); assert(reply);
    return reply;
  } finally { clearTimeout(deadline); if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await once(worker, 'exit'); } }
}

for (const compression of ['none', 'zstd']) {
  test(`JSONL files inventory enumerates historical, current, materialization and migration staging without migrating (${compression})`, async t => {
    const fixture = await open(compression); t.diagnostic(fixture.root);
    try {
      const historical = [];
      for (const version of [0, 1, 2, 3]) historical.push(await seedGeneration(fixture, version));
      const old = historical[0];
      const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd';
      const created = await seedGeneration(fixture, 4, `session.v4${suffix}.123456abcdef.tmp`);
      const migration = await seedGeneration(fixture, 4, `session.migration.1234567890abcdef${suffix}.tmp`);
      const inventory = await fixture.files.inspect('quiet', fixture.header);
      assert.equal(inventory.anchor.resourceId, old);
      assert.deepEqual(inventory.files.map(row => row.resourceId).sort(), [...historical, created, migration, `session.v4${suffix}`].sort());
      assert.equal(nativeJsonlInventorySchema.safeParse(JSON.parse(JSON.stringify(inventory))).success, true);
      for (const row of inventory.files) assert.equal(nativeJsonlFileSchema.safeParse(row).success, true);
      assert.deepEqual(await fixture.files.current(inventory), inventory);
      const before = await readdir(fixture.directory);
      const lease = await fixture.files.acquire(inventory);
      await lease.release();
      assert.deepEqual(await readdir(fixture.directory), before, 'acquiring the file lease publishes no migration or staging');
    } finally { await fixture.close(); }
  });

  test(`JSONL file erasure deletes only frozen file names, retains directory and stable coordination, and leaves sibling transcripts intact (${compression})`, async t => {
    const fixture = await open(compression); t.diagnostic(fixture.root);
    try {
      for (const version of [0, 1, 2, 3]) await seedGeneration(fixture, version);
      const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd';
      await seedGeneration(fixture, 4, `session.v4${suffix}.123456abcdef.tmp`);
      await seedGeneration(fixture, 4, `session.migration.1234567890abcdef${suffix}.tmp`);
      const inventory = await fixture.files.inspect('quiet', fixture.header);
      const sibling = await transcript(fixture, 'sibling');
      const lock = await assertStableSessionLock(fixture.directory);
      const directory = await lstat(fixture.directory, { bigint: true });
      const bytes = await Promise.all(inventory.files.map(row => readFile(join(fixture.directory, row.resourceId))));
      await assert.rejects(fixture.files.erase(inventory, inventory.files[0]), refused('jsonl/lease-required'));
      const lease = await fixture.files.acquire(inventory);
      try {
        for (const row of inventory.files) await fixture.files.erase(inventory, row);
        for (const row of inventory.files) await fixture.files.erase(inventory, row); // exact saved-resource replay only
        const current = await fixture.files.current(inventory);
        assert.deepEqual(current.files, []); assert.deepEqual(current.anchor, inventory.anchor);
      } finally { await lease.release(); }
      assert(bytes.every(value => value.length));
      assert.deepEqual(await readdir(fixture.directory), retainedLockEntries());
      await assertStableSessionLock(fixture.directory, lock);
      const afterDirectory = await lstat(fixture.directory, { bigint: true });
      assert.equal(afterDirectory.ino, directory.ino); assert.equal(afterDirectory.dev, directory.dev);
      assert.equal(await fixture.ctx.sessionPersistence.stat(SessionId('quiet')), undefined);
      assert(!(await fixture.ctx.sessionPersistence.list()).some(value => value.header.id === 'quiet'));
      assert.deepEqual(await transcript(fixture, 'sibling'), sibling);
    } finally { await fixture.close(); }
  });

  test(`JSONL stable file lease rejects a live writer and excludes an independent writer without truncating logs (${compression})`, async () => {
    const fixture = await open(compression); let writer;
    try {
      writer = await fixture.ctx.sessionPersistence.open(SessionId('quiet'), 'write');
      await assert.rejects(fixture.files.acquire(fixture.inventory), refused('jsonl/writer-active'));
      await writer.close(); writer = undefined;
      const inventory = await fixture.files.inspect('quiet', fixture.header);
      const log = await transcript(fixture);
      const lease = await fixture.files.acquire(inventory);
      try { assert.equal((await writerProbe(fixture)).error, 'SessionAlreadyOwnedError'); }
      finally { await lease.release(); await lease.release(); }
      assert.deepEqual(await transcript(fixture), log);
      assert.equal((await writerProbe(fixture)).opened, true);
    } finally { await writer?.close(); await fixture.close(); }
  });
}

for (const resource of ['unknown-file', 'unknown-directory', 'symlink', 'hardlink', 'future', 'noncanonical', 'unreadable-staging', 'foreign-header']) {
  test(`JSONL inventory refuses ${resource} before any erasure`, async () => {
    const fixture = await open();
    const original = await readFile(join(fixture.directory, fixture.inventory.files[0].resourceId));
    try {
      if (resource === 'unknown-file') await writeFile(join(fixture.directory, 'attachment.bin'), 'unowned');
      else if (resource === 'unknown-directory') await mkdir(join(fixture.directory, 'spill'));
      else if (resource === 'symlink') {
        const target = process.platform === 'win32' ? join(fixture.root, 'workspace') : join(fixture.directory, 'session.v4.jsonl');
        await symlink(target, join(fixture.directory, 'session.v3.jsonl'), process.platform === 'win32' ? 'junction' : undefined);
      }
      else if (resource === 'hardlink') await link(join(fixture.directory, 'session.v4.jsonl'), join(fixture.directory, 'session.v3.jsonl'));
      else if (resource === 'future') await writeFile(join(fixture.directory, 'session.v5.jsonl'), physicalHeader(fixture.header, 5));
      else if (resource === 'noncanonical') await writeFile(join(fixture.directory, 'session.v03.jsonl'), physicalHeader(fixture.header, 3));
      else if (resource === 'unreadable-staging') await writeFile(join(fixture.directory, 'session.v4.jsonl.123456abcdef.tmp'), 'partial header');
      else await writeFile(join(fixture.directory, 'session.v3.jsonl'), physicalHeader({ ...fixture.header, id: SessionId('sibling') }, 3));
      await assert.rejects(fixture.files.inspect('quiet', fixture.header));
      assert.deepEqual(await readFile(join(fixture.directory, 'session.v4.jsonl')), original);
      await assertStableSessionLock(fixture.directory);
    } finally { await fixture.close(); }
  });
}

test('JSONL inventory detects duplicate session directories even when the other slot is empty', async () => {
  const fixture = await open();
  try {
    await mkdir(join(fixture.files.root, '_no-cwd', 'quiet'), { recursive: true });
    await assert.rejects(fixture.files.inspect('quiet', fixture.header), refused('jsonl/identity-ambiguous'));
  } finally { await fixture.close(); }
});

test('JSONL file boundary rejects provider claims, changed root config, arbitrary resources, and tampered frozen directories', async () => {
  const fakeRoot = resolve('provider-claim-root');
  assert.equal(await NativeJsonlFiles.open({ name: 'session-persistence-jsonl', root: fakeRoot, config: { root: fakeRoot } }), undefined);
  const fixture = await open();
  try {
    const lease = await fixture.files.acquire(fixture.inventory);
    try {
      await assert.rejects(fixture.files.erase(fixture.inventory, { ...fixture.inventory.files[0], resourceId: '../sibling/session.v4.jsonl' }));
      await assert.rejects(fixture.files.current({ ...fixture.inventory, directory: '../outside' }));
      await assert.rejects(fixture.files.current({ ...fixture.inventory, revision: '0'.repeat(64) }));
    } finally { await lease.release(); }
    fixture.ctx.sessionPersistence.config.root = join(fixture.root, 'different-logs');
    await assert.rejects(fixture.files.current(fixture.inventory), refused('jsonl/provider-changed'));
  } finally { await fixture.close(); }
});

test('JSONL erase refuses bytes or file identity drift after the frozen inventory and refuses a newly entered resource', async () => {
  const fixture = await open();
  try {
    const inventory = fixture.inventory;
    const lease = await fixture.files.acquire(inventory);
    try {
      const row = inventory.files[0];
      await writeFile(join(fixture.directory, row.resourceId), 'tampered bytes');
      await assert.rejects(fixture.files.erase(inventory, row));
      assert.equal(await readFile(join(fixture.directory, row.resourceId), 'utf8'), 'tampered bytes');
      await writeFile(join(fixture.directory, 'unexpected.bin'), 'new member');
      await assert.rejects(fixture.files.erase(inventory, row), refused('jsonl/scope-changed'));
      assert.equal(await readFile(join(fixture.directory, 'unexpected.bin'), 'utf8'), 'new member');
    } finally { await lease.release(); }
  } finally { await fixture.close(); }
});

test('JSONL historical materialization publication hard links are conservatively refused instead of inferred exclusive', async () => {
  const fixture = await open();
  try {
    await link(join(fixture.directory, 'session.v4.jsonl'), join(fixture.directory, 'session.v4.jsonl.123456abcdef.tmp'));
    await assert.rejects(fixture.files.inspect('quiet', fixture.header), refused('jsonl/unsafe-file'));
    if (process.platform === 'win32') {
      const handle = await openFile(join(fixture.directory, 'session.v4.jsonl'), 'r');
      try { assert.equal((await handle.stat({ bigint: true })).nlink, 2n); } finally { await handle.close(); }
    } else assert.equal((await lstat(join(fixture.directory, 'session.v4.jsonl'))).nlink, 2);
  } finally { await fixture.close(); }
});

if (process.platform === 'win32') {
  test('Windows maintenance recovery resumes only an exact saved empty inode', async () => {
    const fixture = await open();
    const row = fixture.inventory.files[0];
    const path = join(fixture.directory, row.resourceId);
    let lease;
    try {
      const before = await lstat(path, { bigint: true });
      const handle = await openFile(path, 'r+');
      try { await handle.truncate(0); await handle.sync(); } finally { await handle.close(); }
      const empty = await lstat(path, { bigint: true });
      assert.equal(empty.size, 0n); assert.equal(empty.dev, before.dev); assert.equal(empty.ino, before.ino);
      assert.equal(empty.birthtimeNs, before.birthtimeNs);
      await assert.rejects(fixture.files.inspect('quiet', fixture.header), refused('jsonl/header-invalid'));
      lease = await fixture.files.acquire(fixture.inventory);
      await assert.rejects(fixture.files.erase(fixture.inventory, row), refused('jsonl/header-invalid'));
      await lease.release(); lease = undefined;
      lease = await fixture.files.acquire(fixture.inventory, { recovering: true });
      await fixture.files.erase(fixture.inventory, row);
      await assert.rejects(lstat(path), error => error.code === 'ENOENT');
    } finally { await lease?.release(); await fixture.close(); }
  });

  test('Windows rejects a hard-linked JSONL resource using the opened handle link count', async () => {
    const fixture = await open();
    const path = join(fixture.directory, 'session.v4.jsonl');
    const alias = join(fixture.directory, 'session.v3.jsonl');
    let handle;
    try {
      await link(path, alias);
      handle = await openFile(path, 'r');
      assert.equal((await handle.stat({ bigint: true })).nlink, 2n);
      await assert.rejects(fixture.files.inspect('quiet', fixture.header), refused('jsonl/unsafe-file'));
    } finally { await handle?.close(); await fixture.close(); }
  });
}

test('JSONL coordination requires a POSIX stable lock but Windows admits only its kernel semaphore', async () => {
  const fixture = await openFixture(await createScratch('native-jsonl-no-lock-'), { plugin: false });
  let writer;
  try {
    const header = fixture.ctx.sessions.prepare(SessionId('historical'), { meta: { createdAt: 123 } }).header;
    const directory = join(fixture.root, 'logs', '_no-cwd', 'historical');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.v3.jsonl'), physicalHeader(header, 3));
    const files = await NativeJsonlFiles.open(fixture.ctx.sessionPersistence); assert(files);
    if (process.platform !== 'win32') {
      await assert.rejects(files.inspect('historical', header), refused('jsonl/lock-missing'));
    } else {
      const inventory = await files.inspect('historical', header);
      assert.equal(inventory.lock.kind, 'win32-semaphore');
      await assertStableSessionLock(directory);
      const lease = await files.acquire(inventory);
      try {
        await assert.rejects(fixture.ctx.sessionPersistence.open(SessionId('historical'), 'write'),
          error => error.name === 'SessionAlreadyOwnedError');
      } finally { await lease.release(); }
      writer = await fixture.ctx.sessionPersistence.open(SessionId('historical'), 'write');
      await assertStableSessionLock(directory);
    }
    if (process.platform !== 'win32') assert.deepEqual(await readdir(directory), ['session.v3.jsonl']);
  } finally { await writer?.close(); await fixture.close(); }
});

test('JSONL stable lease admits a freshly confirmed inventory after a completed pre-lock writer without weakening exact row checks', async () => {
  const fixture = await open();
  try {
    const old = fixture.inventory;
    const writer = await fixture.ctx.sessionPersistence.open(SessionId('quiet'), 'write');
    try {
      await writer.append([
        { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
        { type: 'turn/end', seq: 3, time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
      ]);
      await writer.flush();
    } finally { await writer.close(); }
    const lease = await fixture.files.acquire(old);
    try {
      const fresh = await fixture.files.current(old);
      assert.notEqual(fresh.revision, old.revision); assert.deepEqual(fresh.anchor, old.anchor);
      await assert.rejects(fixture.files.erase(old, old.files[0]), refused('jsonl/resource-changed'));
      // The Host still has to confirm this new digest before invoking the file boundary.
      await fixture.files.erase(fresh, fresh.files[0]);
      assert.deepEqual((await fixture.files.current(old)).files, []);
    } finally { await lease.release(); }
  } finally { await fixture.close(); }
});

test('JSONL release rejects new erasure and retains its stable lock until accepted hashing and unlink settle', { timeout: 15000 }, async () => {
  const fixture = await open();
  const entered = Promise.withResolvers(); const released = Promise.withResolvers();
  const original = fixture.files.readRow.bind(fixture.files); let paused = false;
  fixture.files.readRow = async (...args) => {
    if (!paused) { paused = true; entered.resolve(); await released.promise; }
    return original(...args);
  };
  let erasing; let closing; let closed = false;
  try {
    const lease = await fixture.files.acquire(fixture.inventory);
    erasing = fixture.files.erase(fixture.inventory, fixture.inventory.files[0]); await entered.promise;
    closing = lease.release().then(() => { closed = true; });
    await assert.rejects(fixture.files.erase(fixture.inventory, fixture.inventory.files[0]), refused('jsonl/lease-required'));
    assert.equal((await writerProbe(fixture)).error, 'SessionAlreadyOwnedError'); assert.equal(closed, false);
    released.resolve(); await erasing; await closing;
    assert.deepEqual(await readdir(fixture.directory), retainedLockEntries());
  } finally { released.resolve(); await erasing; await closing; await fixture.close(); }
});

test('JSONL exact inventory follows provider UTF-16 and dot-segment encoding without path traversal', async () => {
  const fixture = await openFixture(await createScratch('native-jsonl-path-'), { plugin: false });
  try {
    const cwd = join(fixture.root, 'workspace', 'space:~\\unicode-\ud800');
    for (const id of ['.', '..', '../escape/~\ud800\u0000']) {
      const session = fixture.ctx.sessions.prepare(SessionId(id), { meta: { cwd, createdAt: 123 } });
      const writer = await fixture.ctx.sessionPersistence.create(session.header);
      try { await writer.flush(); } finally { await writer.close(); }
    }
    const files = await NativeJsonlFiles.open(fixture.ctx.sessionPersistence); assert(files);
    for (const id of ['.', '..', '../escape/~\ud800\u0000']) {
      const snapshot = await fixture.ctx.sessionPersistence.stat(SessionId(id));
      const inventory = await files.inspect(id, snapshot.header);
      assert.equal(inventory.directory.split(sep).length, 2);
      assert(!inventory.directory.split(sep).some(part => part === '.' || part === '..'));
      const lease = await files.acquire(inventory);
      try { for (const row of inventory.files) await files.erase(inventory, row); }
      finally { await lease.release(); }
      assert.deepEqual(await readdir(join(files.root, inventory.directory)), retainedLockEntries());
    }
  } finally { await fixture.close(); }
});

for (const axis of ['ino', 'birthtimeNs']) test(`JSONL rejects an unavailable descriptor ${axis} before admitting erasure`, async () => {
  const fixture = await open();
  const path = join(fixture.directory, fixture.inventory.files[0].resourceId);
  const before = await readFile(path);
  const original = fixture.files.openFile.bind(fixture.files);
  fixture.files.openFile = async (...args) => {
    const handle = await original(...args); const stat = handle.stat.bind(handle);
    handle.stat = async (...options) => {
      const value = await stat(...options);
      return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { [axis]: 0n });
    };
    return handle;
  };
  try {
    await assert.rejects(fixture.files.inspect('quiet', fixture.header), refused('jsonl/identity-unavailable'));
    assert.deepEqual(await readFile(path), before);
    fixture.files.openFile = original;
    assert.deepEqual(await fixture.files.inspect('quiet', fixture.header), fixture.inventory);
    const lease = await fixture.files.acquire(fixture.inventory); await lease.release();
    assert.deepEqual(await readFile(path), before);
  } finally { fixture.files.openFile = original; await fixture.close(); }
});

test('JSONL file boundary propagates unknown filesystem failure instead of fabricating a business refusal', async () => {
  const fixture = await open();
  try {
    fixture.ctx.sessionPersistence.root = join(fixture.root, 'missing-runtime-root');
    await assert.rejects(fixture.files.current(fixture.inventory), error => error.code === 'ENOENT');
  } finally { await fixture.close(); }
});

test('JSONL inventory rejects a same-SID root-level legacy file before erasing its canonical generation', async () => {
  const fixture = await open();
  try {
    await writeFile(join(fixture.files.root, 'quiet.jsonl'), physicalHeader(fixture.header));
    await assert.rejects(fixture.files.inspect('quiet', fixture.header), refused('jsonl/legacy-layout'));
    assert((await lstat(join(fixture.directory, 'session.v4.jsonl'))).isFile());
  } finally { await fixture.close(); }
});

for (const name of ['truncated', 'bad-magic', 'bad-frame-flags']) test(`JSONL Zstandard header identification fails closed for ${name}`, async () => {
  const fixture = await open('zstd');
  try {
    const bytes = zstdCompressSync(physicalHeader(fixture.header, 3));
    if (name === 'bad-magic') bytes[0] = 0;
    else if (name === 'bad-frame-flags') bytes[4] |= 8;
    const damaged = name === 'truncated' ? bytes.subarray(0, bytes.length - 1) : bytes;
    await writeFile(join(fixture.directory, 'session.v3.jsonl.zstd'), damaged, { flag: 'wx' });
    await assert.rejects(fixture.files.inspect('quiet', fixture.header), refused('jsonl/header-invalid'));
    assert.equal((await fixture.ctx.sessionPersistence.stat(SessionId('quiet'))).header.id, 'quiet');
  } finally { await fixture.close(); }
});
