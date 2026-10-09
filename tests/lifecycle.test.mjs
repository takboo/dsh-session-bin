import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import { acquireBinLease } from '../dist/index.js';
import { createScratch, openFixture, transcript, accounting } from './helpers/fixture.mjs';
import { assertCrashExit } from './helpers/platform-fixture.mjs';

const workerPath = new URL('./helpers/worker.mjs', import.meta.url);
async function crashedOperation(root, action, checkpoint) {
  const worker = fork(workerPath, ['crash', root, action, checkpoint], { silent: true });
  let stderr = '';
  let plan;
  worker.stderr.on('data', data => { stderr += data; });
  worker.stdout.resume();
  worker.on('message', message => { if (message.plan) plan = message.plan; });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, 15000);
  const [code, signal] = await once(worker, 'exit');
  clearTimeout(timeout);
  assert.equal(timedOut, false, `Worker timed out before its crash checkpoint: ${stderr}`);
  assertCrashExit(root, checkpoint, code, signal, stderr);
  assert(plan, `Worker did not prepare its operation: ${stderr}`);
  return plan;
}

for (const compression of ['none', 'zstd']) {
  test(`bin/restore preserves JSONL transcript and workspace position (${compression})`, async () => {
    const root = await createScratch();
    let fixture = await openFixture(root, { seed: true, compression });
    const originalAccounting = accounting(fixture);
    const originalLog = await transcript(fixture);
    try {
      await fixture.ctx.workspaceRegistry.archiveSession(SessionId('native-only'));
      await fixture.ctx.workspaceRegistry.pinSession(SessionId('quiet'));
      await fixture.ctx.workspaceRegistry.pinSession(SessionId('sibling'));
      const move = await fixture.bin.prepare({ action: 'bin', sessionId: 'quiet' });
      const moved = await fixture.bin.execute(move);
      assert.equal(moved.status, 'success');
      assert.deepEqual((await fixture.bin.list()).map(entry => entry.sessionId), ['quiet']);
      assert.deepEqual(fixture.ctx.workspaceRegistry.pinnedSessionIds, ['sibling']);
      assert.equal(fixture.ctx.sessions.list().length, 0, 'inspection must not activate cold sessions');
      assert.deepEqual(accounting(fixture), originalAccounting);
      assert.deepEqual(await transcript(fixture), originalLog);
      const restored = await fixture.bin.execute(await fixture.bin.prepare({ action: 'restore', sessionId: 'quiet' }));
      assert.equal(restored.status, 'success');
      assert.equal((await fixture.bin.list()).length, 0);
      assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
      assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('native-only'));
      assert.deepEqual(accounting(fixture), originalAccounting);
      assert.deepEqual(await transcript(fixture), originalLog);
      await fixture.close();
      fixture = await openFixture(root, { compression });
      assert.deepEqual(await fixture.bin.execute(move), moved, 'old move receipt must not re-bin after restore/restart');
      assert.equal((await fixture.bin.list()).length, 0);
      assert.deepEqual(await transcript(fixture), originalLog);
    } finally { await fixture.close(); }
  });
}

test('restoring an originally archived session preserves its original archive', async () => {
  const fixture = await openFixture(await createScratch(), { seed: true });
  try {
    await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
    const result = await fixture.bin.execute(await fixture.bin.prepare({ action: 'bin', sessionId: 'quiet' }));
    assert.equal(result.status, 'success');
    assert.equal((await fixture.bin.list())[0].wasArchived, true);
    assert.equal((await fixture.bin.execute(await fixture.bin.prepare({ action: 'restore', sessionId: 'quiet' }))).status, 'success');
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    assert.equal((await fixture.bin.list()).length, 0);
  } finally { await fixture.close(); }
});

test('all activity families reject bin, including already archived admission and activity after prepare', async () => {
  const fixture = await openFixture(await createScratch(), { seed: true });
  try {
    for (const archived of [false, true]) {
      if (archived) await fixture.ctx.workspaceRegistry.archiveSession(SessionId('active'));
      for (const activity of [['turn'], ['subagent'], ['job'], ['schedule'], ['turn', 'job', 'schedule', 'subagent']]) {
        const plan = await fixture.bin.prepare({ action: 'bin', sessionId: 'active' });
        fixture.state.activity.set('active', activity);
        const result = await fixture.bin.execute(plan);
        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'session-active');
        assert.equal(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('active'), archived);
        assert.equal((await fixture.bin.list()).length, 0);
        fixture.state.activity.delete('active');
      }
    }
    const plan = await fixture.bin.prepare({ action: 'bin', sessionId: 'race' });
    let calls = 0;
    fixture.ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      const rest = await next();
      if (sessionId !== 'race') return rest;
      calls += 1;
      // execute's two plugin checks are quiet; native admission observes new work.
      return calls >= 3 ? [{ kind: 'job' }, ...rest] : rest;
    });
    assert.equal((await fixture.bin.execute(plan)).reason, 'session-active');
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('race'));
    assert.deepEqual(fixture.state.stops, []);
  } finally { await fixture.close(); }
});

test('stale plans, missing sessions, request identity reuse, and concurrent requests remain distinct', async () => {
  const fixture = await openFixture(await createScratch(), { seed: true });
  try {
    const stale = await fixture.bin.prepare({ action: 'bin', sessionId: 'quiet' });
    await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
    assert.equal((await fixture.bin.execute(stale)).status, 'conflict');
    assert.equal((await fixture.bin.list()).length, 0);
    const missing = await fixture.bin.prepare({ action: 'bin', sessionId: 'does-not-exist' });
    assert.equal(missing.blockers[0].code, 'session-not-found');
    assert.equal((await fixture.bin.execute(missing)).reason, 'session-not-found');
    const plan = await fixture.bin.prepare({ action: 'bin', sessionId: 'sibling' });
    const duplicate = await fixture.bin.prepare({ action: 'bin', sessionId: 'sibling' });
    const results = await Promise.all([...Array(12)].map(() => fixture.bin.execute(plan)));
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal(results[0].status, 'success');
    assert.equal((await fixture.bin.execute(duplicate)).status, 'conflict');
    await assert.rejects(fixture.bin.execute({ ...plan, sessionId: 'race' }), error => error.code === 'bin/operation-id-reused');
    assert.equal((await fixture.bin.list()).length, 1);
    const ungrouped = await fixture.bin.execute(await fixture.bin.prepare({ action: 'bin', sessionId: 'ungrouped' }));
    assert.equal(ungrouped.status, 'success');
    assert.equal((await fixture.bin.list()).find(entry => entry.sessionId === 'ungrouped').workspaceIdAtBin, null);
  } finally { await fixture.close(); }
});

test('external unarchive/rearchive releases ownership even if both frames precede reconciliation', async () => {
  const root = await createScratch();
  let fixture = await openFixture(root, { seed: true });
  try {
    assert.equal((await fixture.bin.execute(await fixture.bin.prepare({ action: 'bin', sessionId: 'quiet' }))).status, 'success');
    const restore = await fixture.bin.prepare({ action: 'restore', sessionId: 'quiet' });
    await Promise.all([
      fixture.ctx.workspaceRegistry.unarchiveSession(SessionId('quiet')),
      fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet')),
    ]);
    assert.equal((await fixture.bin.list()).length, 0);
    assert.equal((await fixture.bin.execute(restore)).status, 'conflict');
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    await fixture.close();
    fixture = await openFixture(root);
    assert.equal((await fixture.bin.list()).length, 0);
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
  } finally { await fixture.close(); }
});

for (const action of ['bin', 'restore']) {
  test(`actual process termination recovers every ${action} durability boundary`, { timeout: 90000 }, async () => {
    for (const checkpoint of ['intent', 'native', 'applied', 'entry', 'done']) {
      const root = await createScratch(`crash-${action}-${checkpoint}-`);
      let fixture = await openFixture(root, { seed: true });
      if (action === 'restore') {
        assert.equal((await fixture.bin.execute(await fixture.bin.prepare({ action: 'bin', sessionId: 'quiet' }))).status, 'success');
      }
      const beforeLog = await transcript(fixture);
      const beforeAccounting = accounting(fixture);
      await fixture.close();
      const plan = await crashedOperation(root, action, checkpoint);
      fixture = await openFixture(root);
      try {
        const operation = await fixture.bin.getOperation(plan.operationId);
        assert.equal(operation.phase, 'done', `${action}/${checkpoint}`);
        const uncertain = ['intent', 'native'].includes(checkpoint);
        assert.equal(operation.result.status, uncertain ? 'conflict' : 'success', `${action}/${checkpoint}`);
        const archived = fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet');
        assert.equal(archived, checkpoint === 'intent' ? action === 'restore' : action === 'bin');
        const listed = (await fixture.bin.list()).some(entry => entry.sessionId === 'quiet');
        assert.equal(listed, action === 'bin' ? !uncertain : checkpoint === 'intent', `${action}/${checkpoint} ownership`);
        assert.deepEqual(await fixture.bin.execute(plan), operation.result);
        assert.equal(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'), archived);
        assert.deepEqual(await transcript(fixture), beforeLog);
        assert.deepEqual(accounting(fixture), beforeAccounting);
        if (checkpoint === 'intent') {
          const fresh = await fixture.bin.prepare({ action, sessionId: 'quiet' });
          assert.equal((await fixture.bin.execute(fresh)).status, 'success', 'a new explicit request may retry');
        }
      } finally { await fixture.close(); }
    }
  });
}

test('caller schema validation and snapshots prevent invalid or subsequently mutated domain writes', async () => {
  const fixture = await openFixture(await createScratch(), { seed: true, plugin: false });
  const opened = await fixture.openModule();
  try {
    await opened.module.execute(await opened.module.prepare({ action: 'bin', sessionId: 'quiet' }));
    const entry = (await opened.module.list())[0];
    assert.throws(() => opened.store.putEntry({ ...entry, schemaVersion: 0 }));
    const writing = opened.store.putEntry(entry);
    entry.sessionId = 'changed-after-submission';
    await writing;
    assert.equal(opened.store.entry('quiet').sessionId, 'quiet');
    assert.equal(opened.store.entry('changed-after-submission'), undefined);
    const read = opened.store.entry('quiet');
    read.wasArchived = true;
    assert.equal(opened.store.entry('quiet').wasArchived, false);
    assert.throws(() => opened.module.execute({ bad: 'plan' }));
  } finally { await opened.close(); await fixture.close(); }
});

test('unexpected I/O failure suspends new writes and reopen reconciles durable intent conservatively', async () => {
  const root = await createScratch();
  let fixture = await openFixture(root, { seed: true, plugin: false });
  let opened = await fixture.openModule({ nativeWrapper(native) {
    return { inspect: id => native.inspect(id), activity: id => native.activity(id), unarchive: id => native.unarchive(id),
      async archive(id) { await native.archive(id); throw new Error('injected lost native acknowledgement'); } };
  } });
  const plan = await opened.module.prepare({ action: 'bin', sessionId: 'quiet' });
  try {
    await assert.rejects(opened.module.execute(plan), /injected/);
    await assert.rejects(opened.module.prepare({ action: 'bin', sessionId: 'sibling' }), error => error.code === 'bin/recovery-required');
    await opened.close();
    await fixture.close();
    fixture = await openFixture(root, { plugin: false });
    opened = await fixture.openModule();
    assert.equal((await opened.module.getOperation(plan.operationId)).result.status, 'conflict');
    assert.equal((await opened.module.list()).length, 0);
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
  } finally { await opened.close(); await fixture.close(); }
});

test('close drains admitted native work and holds the lease until domain closes', async () => {
  const root = await createScratch();
  const fixture = await openFixture(root, { seed: true, plugin: false });
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const opened = await fixture.openModule({ nativeWrapper(native) {
    return { inspect: id => native.inspect(id), activity: id => native.activity(id), unarchive: id => native.unarchive(id),
      async archive(id) { entered.resolve(); await gate.promise; await native.archive(id); } };
  } });
  try {
    const executing = opened.module.execute(await opened.module.prepare({ action: 'bin', sessionId: 'quiet' }));
    await entered.promise;
    const closing = opened.close();
    await assert.rejects(acquireBinLease(join(root, 'coordination')), error => error.code === 'bin/lease-unavailable');
    await assert.rejects(opened.module.list(), error => error.code === 'bin/closed');
    gate.resolve();
    assert.equal((await executing).status, 'success');
    await closing;
    const release = await acquireBinLease(join(root, 'coordination'));
    await release();
  } finally { gate.resolve(); await opened.close(); await fixture.close(); }
});

test('a second process cannot take the lifetime lease; process death releases it', async () => {
  const root = await createScratch();
  const worker = fork(workerPath, ['lease', root], { silent: true });
  worker.stdout.resume();
  let stderr = '';
  worker.stderr.on('data', data => { stderr += data; });
  try {
    const ready = await Promise.race([once(worker, 'message'), once(worker, 'exit').then(() => { throw new Error(stderr); })]);
    assert(ready[0].ready);
    await assert.rejects(acquireBinLease(join(root, 'coordination')), error => error.code === 'bin/lease-unavailable');
    worker.kill('SIGKILL');
    await once(worker, 'exit');
    const release = await acquireBinLease(join(root, 'coordination'));
    await release();
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await once(worker, 'exit'); }
  }
});
