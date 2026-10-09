import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { lstat, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createScratch } from './helpers/fixture.mjs';
import { openNativeDeletionFixture } from './helpers/native-deletion-fixture.mjs';
import { assertCrashExit } from './helpers/platform-fixture.mjs';

const enabled = process.platform === 'win32' && process.env.DSH_SESSION_BIN_PLATFORM_VERIFY === '1';
const windowsTest = enabled ? test : test.skip;
const stagePrefix = '.dsh-session-bin-cache-';

async function preparedRoot(name) {
  const root = await createScratch(name);
  const fixture = await openNativeDeletionFixture(root, { seed: true });
  const table = fixture.ctx.get('sessionProjectionCache').requireTable();
  await table.delete('sibling');
  const tableDirectory = table.host.unit.tableDir('sessions');
  assert.deepEqual((await readdir(tableDirectory)).filter(file => file.endsWith('.json')), ['quiet.json']);
  const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
  assert.deepEqual(plan.blockers, []);
  const snapshot = fixture.nativeOwner.witness('quiet').metadata.cache;
  assert(snapshot.physicalIdentity);
  return { root, fixture, plan, tableDirectory, snapshot };
}

async function stages(tableDirectory) {
  return (await readdir(tableDirectory)).filter(name => name.startsWith(stagePrefix));
}

async function killAt(root, boundary, plan) {
  const worker = fork(new URL('./helpers/windows-cache-worker.mjs', import.meta.url),
    [root, boundary, JSON.stringify(plan)], { silent: true });
  let stderr = ''; let sent; let timedOut = false;
  worker.stdout.resume(); worker.stderr.on('data', chunk => { stderr += chunk; });
  worker.on('message', value => { sent = value.plan; });
  const timeout = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, 20000);
  try {
    const [code, signal] = await once(worker, 'exit');
    assert.equal(timedOut, false, stderr);
    assertCrashExit(root, boundary, code, signal, stderr);
    assert.deepEqual(sent, plan);
  } finally {
    clearTimeout(timeout);
    if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await once(worker, 'exit'); }
  }
}

windowsTest('Windows projection cache refuses a legacy whole-unit bootstrap source', { timeout: 30000 }, async () => {
  const root = await createScratch('windows-cache-legacy-bootstrap-');
  const fixture = await openNativeDeletionFixture(root, { seed: true });
  try {
    const table = fixture.ctx.get('sessionProjectionCache').requireTable();
    const legacyPath = join(dirname(table.host.unit.dir), 'session_projcache.json');
    await writeFile(legacyPath, '{"unit":{"name":"session_projcache","version":7},"tables":{"sessions":{}}}', { flag: 'wx', flush: true });
    await assert.rejects(fixture.nativeOwner.metadata.capture('quiet'), error => error.code === 'native/cache-unclassified-resource');
    assert(await lstat(join(table.host.unit.tableDir('sessions'), 'quiet.json')));
  } finally { await fixture.close(); }
});

windowsTest('Windows projection cache erasure stages, clears, and removes the exact frozen document', { timeout: 30000 }, async () => {
  const state = await preparedRoot('windows-cache-success-');
  try {
    const result = await state.fixture.module.executePurge(state.plan);
    assert.equal(result.status, 'success', JSON.stringify(result));
    await assert.rejects(lstat(join(state.tableDirectory, 'quiet.json')), error => error.code === 'ENOENT');
    assert.deepEqual(await stages(state.tableDirectory), []);
  } finally { await state.fixture.close(); }
});

for (const boundary of ['cache-renamed', 'cache-stage-cleared']) {
  windowsTest(`Windows projection cache recovers the same operation after ${boundary} acknowledgement loss`, { timeout: 60000 }, async () => {
    const state = await preparedRoot(`windows-cache-${boundary}-`);
    await state.fixture.close();
    await killAt(state.root, boundary, state.plan);
    const staged = await stages(state.tableDirectory);
    await assert.rejects(lstat(join(state.tableDirectory, 'quiet.json')), error => error.code === 'ENOENT');
    assert.equal(staged.length, 1);
    assert.equal(staged[0].endsWith('.json'), false);
    const stagedBytes = await readFile(join(state.tableDirectory, staged[0]));
    if (boundary === 'cache-renamed') assert(stagedBytes.length > 0);
    else assert.equal(stagedBytes.length, 0);
    // Cache mounts and loads before the retirement owner resumes. The stage is
    // intentionally outside the SDK's .json record namespace.
    const reopened = await openNativeDeletionFixture(state.root);
    try {
      const operation = await reopened.module.getPurgeOperation(state.plan.operationId);
      assert.equal(operation.phase, 'done');
      assert.equal(operation.result.status, 'success');
      assert.equal(reopened.ctx.get('sessionProjectionCache').requireTable().get('quiet'), undefined);
      assert.deepEqual(await stages(state.tableDirectory), []);
    } finally { await reopened.close(); }
  });
}

windowsTest('Windows metadata convergence refuses a foreign stage without modifying it', { timeout: 30000 }, async () => {
  const state = await preparedRoot('windows-cache-foreign-stage-');
  const foreign = join(state.tableDirectory, `${stagePrefix}${'f'.repeat(64)}.stage`);
  const bytes = Buffer.from('foreign cache stage bytes');
  await writeFile(foreign, bytes, { flag: 'wx', flush: true });
  try {
    const owner = state.fixture.nativeOwner;
    const witness = owner.witness('quiet');
    owner.admission.markRetired('quiet');
    const request = { operationId: state.plan.operationId, expected: state.plan.binding.lifecycle,
      bin: { kind: 'native-archive', entryId: state.plan.expectedEntryId, entryVersion: 2 }, manifestDigest: 'a'.repeat(64) };
    await assert.rejects(owner.metadata.converge(witness.metadata, state.plan.binding.lifecycle, request),
      error => error.code === 'native/cache-unclassified-resource');
    assert.deepEqual(await readFile(foreign), bytes);
    assert(await lstat(join(state.tableDirectory, 'quiet.json')));
  } finally { await state.fixture.close(); }
});

windowsTest('Windows same-operation recovery leaves an identity-drifted stage untouched', { timeout: 60000 }, async () => {
  const state = await preparedRoot('windows-cache-stage-drift-');
  await state.fixture.close();
  await killAt(state.root, 'cache-renamed', state.plan);
  const [stageName] = await stages(state.tableDirectory); assert(stageName);
  const stagePath = join(state.tableDirectory, stageName);
  await unlink(stagePath);
  const drifted = Buffer.from('replacement outside the frozen cache snapshot');
  await writeFile(stagePath, drifted, { flag: 'wx', flush: true });
  const reopened = await openNativeDeletionFixture(state.root);
  try {
    const operation = await reopened.module.getPurgeOperation(state.plan.operationId);
    assert.notEqual(operation.result?.status, 'success');
    assert.deepEqual(await readFile(stagePath), drifted);
  } finally { await reopened.close(); }
});
