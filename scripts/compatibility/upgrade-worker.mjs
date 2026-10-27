import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { openNativeDeletionFixture } from '../../tests/helpers/native-deletion-fixture.mjs';
import { createScratch } from '../../tests/helpers/fixture.mjs';
import { assertCrashExit } from '../../tests/helpers/platform-fixture.mjs';
const [mode, manifestFile] = process.argv.slice(2);
if (mode === 'seed') {
  const samples = [];
  for (const compression of ['none', 'zstd']) for (const state of ['prepared', 'done', 'owner-fenced', 'resource-effect']) {
    const root = await createScratch(`upgrade-${compression}-${state}-`);
    const fixture = await openNativeDeletionFixture(root, { seed: true, compression });
    let plan;
    try {
      plan = await fixture.module.preparePurge({ sessionId: 'quiet', operationId: `upgrade-${compression}-${state}` });
      assert.deepEqual(plan.blockers, []);
      if (state === 'done') assert.equal((await fixture.module.executePurge(plan)).status, 'success');
    } finally { await fixture.close(); }
    if (['owner-fenced', 'resource-effect'].includes(state)) {
      await new Promise((resolve, reject) => {
        const child = fork(new URL('../../tests/helpers/native-deletion-worker.mjs', import.meta.url), [root, state, JSON.stringify(plan), compression], { silent: true });
        let stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Upgrade crash worker timed out')); }, 30000);
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', (code, signal) => { clearTimeout(timer); try { assertCrashExit(root, state, code, signal, stderr); resolve(); } catch (e) { reject(e); } });
      });
    }
    samples.push({ root, compression, state, plan });
  }
  await writeFile(manifestFile, JSON.stringify(samples, null, 2));
} else {
  assert.equal(mode, 'verify');
  const samples = JSON.parse(await readFile(manifestFile, 'utf8'));
  for (const sample of samples) {
    const fixture = await openNativeDeletionFixture(sample.root, { compression: sample.compression });
    try {
      const result = await fixture.module.executePurge(sample.plan);
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.deepEqual(await fixture.module.executePurge(sample.plan), result);
      assert.equal(await fixture.ctx.sessionPersistence.stat('quiet'), undefined);
      assert(await fixture.ctx.sessionPersistence.stat('sibling'));
    } finally { await fixture.close(); }
  }
  console.log(JSON.stringify({ status: 'passed', samples: samples.map(s => ({ compression: s.compression, state: s.state })), scope: 'Same frozen plans and operation IDs across a cold dependency upgrade; explicit retry only; sibling retained.' }));
}
