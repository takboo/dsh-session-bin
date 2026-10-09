import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import { SessionId, SessionStore, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createScratch, openFixture, transcript } from './helpers/fixture.mjs';
import { assertStableSessionLock } from './helpers/platform-fixture.mjs';

// Admission probes, not an erasure implementation. Public SDK operations only;
// historical/damaged artifacts are seeded in fresh scratch data and never removed.
const require = createRequire(import.meta.url);
const cliRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const sdkRequire = createRequire(cliRequire.resolve('@deepseek-ai/dsh-base/package.json'));
const workerPath = new URL('./helpers/persistence-worker.mjs', import.meta.url);
const events = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
];

async function probeWriter(root, compression, id) {
  const worker = fork(workerPath, [root, compression, id], { silent: true });
  let stderr = '';
  let result;
  worker.stdout.resume();
  worker.stderr.on('data', data => { stderr += data; });
  worker.on('message', message => { result = message; });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, 15000);
  try {
    const [code, signal] = await once(worker, 'exit');
    assert.equal(timedOut, false, stderr);
    assert.equal(code, 0, stderr);
    assert.equal(signal, null, stderr);
    assert(result, `worker must report a result: ${stderr}`);
    return result;
  } finally {
    clearTimeout(deadline);
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
      await once(worker, 'exit');
    }
  }
}

async function quietDirectory(root) {
  const logs = join(root, 'logs');
  const matches = [];
  for (const project of await readdir(logs, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const candidate = join(logs, project.name, 'quiet');
    try { if ((await stat(candidate)).isDirectory()) matches.push(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.equal(matches.length, 1);
  return matches[0];
}

for (const compression of ['none', 'zstd']) {
  test(`deletion admission: flush preserves writer exclusion and coordination identity (${compression})`, async t => {
    const root = await createScratch('deletion-flush-');
    t.diagnostic(root);
    const fixture = await openFixture(root, { seed: true, plugin: false, compression });
    let writer;
    let reader;
    try {
      const id = SessionId('quiet');
      writer = await fixture.ctx.sessionPersistence.open(id, 'write');
      reader = await fixture.ctx.sessionPersistence.open(id, 'read');
      const directory = await quietDirectory(root);
      const before = await assertStableSessionLock(directory);
      const revision = (await fixture.ctx.sessionPersistence.stat(id)).revision;
      await fixture.ctx.sessionPersistence.flush();
      assert.deepEqual((await reader.read()).events, events);
      assert.equal((await probeWriter(root, compression, id)).error, 'SessionAlreadyOwnedError');
      await writer.close(); writer = undefined;
      assert.equal((await probeWriter(root, compression, id)).opened, true);
      await assertStableSessionLock(directory, before);
      assert.equal((await fixture.ctx.sessionPersistence.stat(id)).revision, revision,
        'writer churn does not provide a lifecycle revision');
      assert.deepEqual((await reader.read()).events, events, 'writer close leaves a read handle alive');
    } finally { await reader?.close(); await writer?.close(); await fixture.close(); }
  });

  test(`deletion admission: detach does not await writer close or disposal observers (${compression})`, async t => {
    const root = await createScratch('deletion-disposal-');
    t.diagnostic(root);
    const fixture = await openFixture(root, { plugin: false, compression });
    const closeGate = Promise.withResolvers();
    const observerGate = Promise.withResolvers();
    const observerDone = Promise.withResolvers();
    let writer;
    let reader;
    let detach;
    let closeStarted = false;
    let closeCompleted = false;
    let observerStarted = false;
    let observerCompleted = false;
    try {
      const session = fixture.ctx.sessions.prepare(SessionId('disposal'), { meta: { createdAt: 123 } });
      writer = await fixture.ctx.sessionPersistence.create(session.header);
      // Delay the caller-owned public close method to model a slow resource owner.
      const originalClose = writer.close.bind(writer);
      let closing;
      writer.close = () => closing ??= (async () => {
        closeStarted = true;
        await closeGate.promise;
        await originalClose();
        closeCompleted = true;
      })();
      fixture.ctx.on('session/disposed', async disposed => {
        if (disposed !== session) return;
        observerStarted = true;
        await observerGate.promise;
        observerCompleted = true;
        observerDone.resolve();
      });
      detach = fixture.ctx.sessions.enter(session);
      fixture.ctx.sessions.announce(session);
      session.append('turn/start', { turn: 1 });
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      assert.equal(await fixture.ctx.sessions.flush(session), true);
      reader = await fixture.ctx.sessionPersistence.open(session.id, 'read');
      const stored = await reader.read();
      assert.equal(detach(), undefined);
      assert.equal(fixture.ctx.sessions.get(session.id), undefined);
      assert.equal(closeStarted, true);
      assert.equal(closeCompleted, false);
      assert.equal(observerStarted, true);
      assert.equal(observerCompleted, false);
      assert.equal((await probeWriter(root, compression, session.id)).error, 'SessionAlreadyOwnedError');
      closeGate.resolve();
      await writer.close();
      assert.equal((await probeWriter(root, compression, session.id)).opened, true);
      assert.equal(observerCompleted, false, 'writer release still does not settle every observer');
      assert.deepEqual(await reader.read(), stored, 'retained reads have their own lifetime');
      observerGate.resolve();
      await observerDone.promise;
    } finally {
      closeGate.resolve(); observerGate.resolve(); detach?.();
      await reader?.close(); await writer?.close(); await fixture.close();
    }
  });
}

test('deletion admission: an archived quiet session still admits a persistence writer', async t => {
  const root = await createScratch('deletion-archive-');
  t.diagnostic(root);
  const fixture = await openFixture(root, { seed: true });
  let writer;
  try {
    assert.equal((await fixture.bin.execute(await fixture.bin.prepare({ action: 'bin', sessionId: 'quiet' }))).status, 'success');
    assert.deepEqual(await fixture.ctx.waterfall('workspace/session-activity', { sessionId: SessionId('quiet') }, async () => []), []);
    writer = await fixture.ctx.sessionPersistence.open(SessionId('quiet'), 'write');
    await writer.append([
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
    ]);
    await writer.flush();
    assert.equal((await transcript(fixture)).events.length, 4);
    assert.equal((await fixture.bin.list()).length, 1);
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
  } finally { await writer?.close(); await fixture.close(); }
});

test('deletion admission: identical headers cannot distinguish exact live lifecycles', async t => {
  const root = await createScratch('deletion-identity-');
  t.diagnostic(root);
  const fixture = await openFixture(root, { plugin: false });
  let detachSecond;
  try {
    const id = SessionId('reused');
    const meta = { createdAt: 123, cwd: join(root, 'workspace') };
    const first = fixture.ctx.sessions.prepare(id, { meta });
    const detachFirst = fixture.ctx.sessions.enter(first);
    fixture.ctx.sessions.announce(first);
    detachFirst();
    const second = fixture.ctx.sessions.prepare(id, { meta });
    detachSecond = fixture.ctx.sessions.enter(second);
    fixture.ctx.sessions.announce(second);
    assert.notEqual(first, second);
    assert.deepEqual(first.header, second.header);
    detachFirst();
    assert.equal(fixture.ctx.sessions.get(id), second, 'old capability cannot detach the successor');
  } finally { detachSecond?.(); await fixture.close(); }
});

test('deletion admission: unmaterialized sessions are visible only to their persistence instance', async t => {
  const root = await createScratch('deletion-pending-');
  t.diagnostic(root);
  const fixture = await openFixture(root, { plugin: false });
  const other = new Context();
  let writer;
  try {
    await other.plugin(SessionStore);
    await other.plugin(Jsonl, { root: join(root, 'logs'), compression: 'none' });
    assert.notEqual(fixture.ctx.sessionPersistence.identity, other.sessionPersistence.identity);
    const session = fixture.ctx.sessions.prepare(SessionId('pending'), { meta: { createdAt: 123 } });
    writer = await fixture.ctx.sessionPersistence.create(session.header);
    assert((await fixture.ctx.sessionPersistence.stat(session.id)).header);
    assert.equal(await other.sessionPersistence.stat(session.id), undefined);
    await writer.flush();
    assert((await other.sessionPersistence.stat(session.id)).header);
    await writer.close(); writer = undefined;
    await other.fiber.dispose();
    const reopened = new Context();
    try {
      await reopened.plugin(SessionStore);
      await reopened.plugin(Jsonl, { root: join(root, 'logs'), compression: 'none' });
      assert.notEqual(fixture.ctx.sessionPersistence.identity, reopened.sessionPersistence.identity);
      assert((await reopened.sessionPersistence.stat(session.id)).header);
    } finally { await reopened.fiber.dispose(); }
  } finally { await writer?.close(); await other.fiber.dispose(); await fixture.close(); }
});

for (const compression of ['none', 'zstd']) {
  test(`deletion admission: historical read preserves predecessor, write publishes a successor (${compression})`, async t => {
    const root = await createScratch('deletion-generation-');
    t.diagnostic(root);
    const directory = join(root, 'logs', '_no-cwd', 'historical');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd';
    const path = join(directory, `session.v3${suffix}`);
    const headerBytes = Buffer.from(`${JSON.stringify({ type: 'session', version: 3, id: 'historical', createdAt: 123, isSeeded: false, delegationDepth: 0 })}\n`);
    const eventBytes = Buffer.from([...events.map(value => JSON.stringify(value)), ''].join('\n'));
    const physical = compression === 'none' ? Buffer.concat([headerBytes, eventBytes])
      : Buffer.concat([zstdCompressSync(headerBytes), zstdCompressSync(eventBytes)]);
    await writeFile(path, physical, { flag: 'wx', mode: 0o600 });
    const fixture = await openFixture(root, { plugin: false, compression });
    let reader;
    let writer;
    try {
      const snapshot = await fixture.ctx.sessionPersistence.stat(SessionId('historical'));
      assert.equal(snapshot.header.version, SESSION_FORMAT_VERSION);
      assert.equal(SESSION_FORMAT_VERSION, 4, 'probe is pinned to the actual SDK format');
      reader = await fixture.ctx.sessionPersistence.open(SessionId('historical'), 'read');
      assert.deepEqual((await reader.read()).events, events);
      assert.deepEqual(await readdir(directory), [`session.v3${suffix}`], 'read must not publish a successor');
      writer = await fixture.ctx.sessionPersistence.open(SessionId('historical'), 'write');
      assert((await readdir(directory)).includes(`session.v${SESSION_FORMAT_VERSION}${suffix}`));
      assert.deepEqual(await readFile(path), physical, 'migration preserves historical bytes');
      assert.deepEqual((await reader.read()).events, events);
      await writer.close(); writer = undefined;
      assert.deepEqual(await readFile(path), physical);
    } finally { await reader?.close(); await writer?.close(); await fixture.close(); }
  });

  test(`deletion admission: stat/list omission cannot certify artifact absence (${compression})`, async t => {
    const root = await createScratch('deletion-unreadable-');
    t.diagnostic(root);
    const directory = join(root, 'logs', '_no-cwd', 'unreadable');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl${compression === 'zstd' ? '.zstd' : ''}`);
    const bytes = Buffer.from('not-json\n');
    await writeFile(path, compression === 'none' ? bytes : zstdCompressSync(bytes), { flag: 'wx', mode: 0o600 });
    const fixture = await openFixture(root, { plugin: false, compression });
    try {
      assert.equal(await fixture.ctx.sessionPersistence.stat(SessionId('unreadable')), undefined);
      assert.deepEqual(await fixture.ctx.sessionPersistence.list(), []);
      assert((await stat(path)).size > 0, 'bytes remain despite an absent public snapshot');
    } finally { await fixture.close(); }
  });
}

test('deletion admission: equal file bytes under different names share one attachment inode', async t => {
  const root = await createScratch('deletion-shared-file-');
  t.diagnostic(root);
  const fixture = await openFixture(root, { plugin: false });
  const { default: Attachments } = await import(sdkRequire.resolve('@deepseek-ai/dsh-attachment-local'));
  try {
    await fixture.mount(Attachments, { dshHome: join(root, 'dsh-home') });
    const bytes = Buffer.from('isolated shared attachment\n');
    const first = await fixture.ctx.attachments.saveFile({ name: 'first.txt', data: bytes });
    const second = await fixture.ctx.attachments.saveFile({ name: 'second.txt', data: bytes });
    assert.equal(first.attachmentId, second.attachmentId);
    assert.notEqual(first.name, second.name);
    const firstPath = fixture.ctx.attachments.fileHostPath(first);
    const secondPath = fixture.ctx.attachments.fileHostPath(second);
    for (const path of [firstPath, secondPath]) {
      const rel = relative(root, await realpath(path));
      assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    }
    const firstStat = await stat(firstPath, { bigint: true });
    const secondStat = await stat(secondPath, { bigint: true });
    assert.equal(firstStat.dev, secondStat.dev);
    assert.equal(firstStat.ino, secondStat.ino);
    assert(firstStat.nlink >= 3n, 'canonical object and two named links survive');
    assert.deepEqual(await readFile(firstPath), bytes);
    assert.deepEqual(await readFile(secondPath), bytes);
  } finally { await fixture.close(); }
});
