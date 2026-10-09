import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createScratch, transcript } from './helpers/fixture.mjs';
import { openNativeDeletionFixture } from './helpers/native-deletion-fixture.mjs';
import { assertCrashExit, crashAt } from './helpers/platform-fixture.mjs';

async function killAt(root, boundary, plan, compression) {
  const worker = fork(new URL('./helpers/native-deletion-worker.mjs', import.meta.url), [root, boundary, JSON.stringify(plan), compression], { silent: true });
  let stderr = ''; let sent; let timedOut = false;
  worker.stdout.resume(); worker.stderr.on('data', chunk => { stderr += chunk; });
  worker.on('message', value => { sent = value.plan; });
  const timeout = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, 20000);
  try {
    const [code, signal] = await once(worker, 'exit');
    assert.equal(timedOut, false, stderr); assertCrashExit(root, boundary, code, signal, stderr);
    assert.deepEqual(sent, plan);
  } finally {
    clearTimeout(timeout);
    if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await once(worker, 'exit'); }
  }
}

test('crash exit evidence rejects a Windows-shaped code 1 exit without checkpoint proof', async () => {
  const root = await createScratch('crash-proof-missing-');
  process.env.DSH_HOME = join(root, 'dsh-home');
  assert.throws(() => assertCrashExit(root, 'not-reached', 1, null, 'fake crash'), /checkpoint proof/);
});

for (const mode of ['returned', 'threw']) test(`checkpoint proof cannot authenticate a kill that ${mode}`, async () => {
  const root = await createScratch('crash-proof-not-forced-');
  process.env.DSH_HOME = join(root, 'dsh-home');
  const originalKill = process.kill; const originalWrite = process.stderr.write;
  let stderr = '';
  try {
    process.kill = () => { if (mode === 'threw') throw new Error('injected kill failure'); return true; };
    process.stderr.write = chunk => { stderr += String(chunk); return true; };
    assert.throws(() => crashAt(root, 'selected'), /instead of forcibly terminating/);
  } finally { process.kill = originalKill; process.stderr.write = originalWrite; }
  assert(stderr.includes('DSH_TEST_CRASH_NOT_FORCED'));
  assert.throws(() => assertCrashExit(root, 'selected', 1, null, ''), /post-kill or normal-exit failure/);
});

const nativeDeletionBoundaries = ['plugin-intent', 'plugin-authorizing', 'owner-fenced', 'resource-effect', 'owner-done', 'plugin-entry', 'plugin-done',
  ...(process.platform === 'win32' ? ['file-cleared'] : [])];
for (const compression of ['none', 'zstd']) test(`actual native deletion recovers real log/cache/SQLite effects at ${nativeDeletionBoundaries.length} SIGKILL boundaries (${compression})`, { timeout: 90000 }, async t => {
  for (const boundary of nativeDeletionBoundaries) {
    const root = await createScratch(`native-delete-crash-${compression}-${boundary}-`); t.diagnostic(root);
    let fixture = await openNativeDeletionFixture(root, { seed: true, compression });
    const sibling = await transcript(fixture, 'sibling');
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' }); assert.deepEqual(plan.blockers, []);
    const frozen = boundary === 'file-cleared' ? fixture.nativeOwner.witness('quiet').inventory : null;
    await fixture.close(); await killAt(root, boundary, plan, compression);
    if (boundary === 'file-cleared') {
      assert(frozen);
      assert.equal(frozen.files.length, 1);
      const row = frozen.files[0];
      const cleared = await lstat(join(frozen.root, frozen.directory, row.resourceId), { bigint: true });
      assert(cleared.isFile());
      assert.equal(String(cleared.dev), row.identity.dev);
      assert.equal(String(cleared.ino), row.identity.ino);
      assert.equal(String(cleared.birthtimeNs), row.identity.birthtimeNs);
      assert.equal(cleared.size, 0n);
    }
    fixture = await openNativeDeletionFixture(root, { compression });
    try {
      const operation = await fixture.module.getPurgeOperation(plan.operationId);
      assert.equal(operation.phase, 'done', boundary);
      const interrupted = ['plugin-intent', 'plugin-authorizing'].includes(boundary);
      assert.equal(operation.result.status, interrupted ? 'conflict' : 'success', JSON.stringify(operation.result));
      assert.deepEqual(await fixture.module.executePurge(plan), operation.result);
      if (interrupted) assert(await fixture.ctx.sessionPersistence.stat(SessionId('quiet')));
      else {
        assert.equal(await fixture.ctx.sessionPersistence.stat(SessionId('quiet')), undefined);
        assert.equal(fixture.ctx.get('sessionProjectionCache').requireTable().get('quiet'), undefined);
        assert.equal(fixture.ctx.get('sessionQuery')._db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get('quiet'), undefined);
        assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
      }
      assert.deepEqual(await transcript(fixture, 'sibling'), sibling);
    } finally { await fixture.close(); }
  }
});
