import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createScratch, openFixture, transcript, accounting } from './helpers/fixture.mjs';
import { assertCrashExit } from './helpers/platform-fixture.mjs';

async function crash(root, checkpoint) {
  const worker = fork(new URL('./helpers/archive-worker.mjs', import.meta.url), [root, checkpoint], { silent: true });
  let stderr = '';
  let plan;
  worker.stderr.on('data', data => { stderr += data; });
  worker.stdout.resume();
  worker.on('message', message => { if (message.plan) plan = message.plan; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, 15000);
  const [code, signal] = await once(worker, 'exit');
  clearTimeout(timer);
  assert.equal(timedOut, false, `Checkpoint timed out: ${stderr}`);
  assertCrashExit(root, checkpoint, code, signal, stderr);
  assert(plan, `Worker did not send a plan: ${stderr}`);
  return plan;
}

test('production unarchive recovers five actual SIGKILL durability boundaries without replaying native changes', { timeout: 90000 }, async () => {
  for (const checkpoint of ['intent', 'native', 'applied', 'entry', 'done']) {
    const root = await createScratch(`archive-crash-${checkpoint}-`);
    let fixture = await openFixture(root, { seed: true, legacy: false });
    try {
      await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
      await fixture.bin.list();
      const beforeLog = await transcript(fixture);
      const beforeAccounting = accounting(fixture);
      await fixture.close();
      const plan = await crash(root, checkpoint);
      fixture = await openFixture(root, { legacy: false });
      const receipt = await fixture.bin.getOperation(plan.operationId);
      assert.equal(receipt.phase, 'done', checkpoint);
      const uncertain = ['intent', 'native'].includes(checkpoint);
      assert.equal(receipt.result.status, uncertain ? 'conflict' : 'success', checkpoint);
      if (uncertain) assert.equal(receipt.result.reason, 'interrupted');
      assert.equal(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'), checkpoint === 'intent');
      assert.equal((await fixture.bin.list()).some(entry => entry.sessionId === 'quiet'), checkpoint === 'intent');
      const nativeWrites = fixture.state.changes.filter(change => change.domain === 'workspace').length;
      assert.deepEqual(await fixture.bin.execute(plan), receipt.result);
      assert.equal(fixture.state.changes.filter(change => change.domain === 'workspace').length, nativeWrites,
        'Historical request must not perform another native write');
      assert.deepEqual(await transcript(fixture), beforeLog);
      assert.deepEqual(accounting(fixture), beforeAccounting);
      if (checkpoint === 'intent') {
        const fresh = await fixture.bin.prepare({ action: 'unarchive', sessionId: 'quiet' });
        assert.equal((await fixture.bin.execute(fresh)).status, 'success');
      }
    } finally { await fixture.close(); }
  }
});
