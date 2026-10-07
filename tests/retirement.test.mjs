import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as bin from '../dist/index.js';
import { createScratch, transcript, accounting } from './helpers/fixture.mjs';
import { latch, openRetirementFixture, override } from './helpers/retirement-owner.mjs';

const workerPath = new URL('./helpers/retirement-worker.mjs', import.meta.url);
const clone = value => structuredClone(value);
async function move(fixture, sessionId = 'quiet', operationId) {
  const plan = await fixture.module.prepare({ action: 'bin', sessionId, ...(operationId ? { operationId } : {}) });
  const result = await fixture.module.execute(plan);
  assert.equal(result.status, 'success');
  return result;
}
async function restore(fixture, sessionId = 'quiet', operationId) {
  return fixture.module.execute(await fixture.module.prepare({ action: 'restore', sessionId, ...(operationId ? { operationId } : {}) }));
}
function observe(promise) { return promise.then(value => ({ value }), error => ({ error })); }
function containsFailure(error, text, seen = new Set()) {
  if (!error || seen.has(error)) return false;
  seen.add(error);
  return String(error.message).includes(text)
    || containsFailure(error.cause, text, seen)
    || (Array.isArray(error.errors) && error.errors.some(item => containsFailure(item, text, seen)));
}
async function assertResourcesRetired(owner, lifecycle) {
  const snapshot = await owner.resourceSnapshot(lifecycle);
  for (const item of snapshot) {
    if (['erase', 'release-reference'].includes(item.resource.disposition)) assert.equal(item.record, null, item.resource.resourceId);
    else assert(item.record, item.resource.resourceId);
    if (item.resource.disposition === 'retain-shared') {
      assert.equal(item.record.references.length, 1);
      assert.equal(item.resource.retention.reason, 'shared-reference');
      const retained = item.resource.retention.retainedBy;
      assert.equal(retained.length, 1);
      assert.equal(item.record.references[0], retained[0].lifecycleId);
      assert.deepEqual(owner.domain.table('protected').get(retained[0].lifecycleId), retained[0]);
      assert(!bin.lifecycleEqual(retained[0], lifecycle));
      assert(item.record.payload);
    }
  }
}
async function killAt(root, checkpoint, plan) {
  const worker = fork(workerPath, [root, checkpoint, JSON.stringify(plan)], { silent: true });
  let stderr = '';
  let sent;
  let timedOut = false;
  worker.stdout.resume();
  worker.stderr.on('data', data => { stderr += data; });
  worker.on('message', message => { sent = message.plan; });
  const timeout = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, 20000);
  try {
    const [code, signal] = await once(worker, 'exit');
    assert.equal(timedOut, false, stderr);
    assert.equal(code, null, stderr);
    assert.equal(signal, 'SIGKILL', stderr);
    assert.deepEqual(sent, plan);
  } finally {
    clearTimeout(timeout);
    if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await once(worker, 'exit'); }
  }
}

test('purge defaults to unsupported and never treats native archives or legacy entries as authorized targets', async t => {
  const root = await createScratch('purge-disabled-');
  t.diagnostic(root);
  let fixture = await openRetirementFixture(root, { seed: true, ownerEnabled: false });
  const before = await transcript(fixture);
  try {
    await move(fixture);
    const disabled = await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert(disabled.blockers.some(item => item.code === 'permanent-deletion-unsupported'));
    const rejected = await fixture.module.executePurge(disabled);
    assert.equal(rejected.status, 'rejected');
    assert.equal((await fixture.module.getPurgeOperation(disabled.operationId)).phase, 'done');
    await fixture.ctx.workspaceRegistry.archiveSession(SessionId('native-only'));
    const nativeOnly = await fixture.module.preparePurge({ sessionId: 'native-only' });
    assert(nativeOnly.blockers.some(item => item.code === 'not-in-bin'));
    assert.equal((await fixture.module.executePurge(nativeOnly)).status, 'rejected');
    assert.equal(fixture.owner.retireCalls, 0);
    await fixture.close();
    fixture = await openRetirementFixture(root);
    const legacy = await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert(legacy.blockers.some(item => item.code === 'lifecycle-unbound'));
    assert.equal(legacy.binding, null, 'preparation must not attach a current lifecycle to a legacy entry');
    assert.equal((await restore(fixture)).status, 'success');
    assert.deepEqual(await transcript(fixture), before);
    assert.deepEqual(fixture.state.stops, []);
  } finally { await fixture.close(); }
});

test('an owner capability claim cannot enable purge without Host composition qualification', async () => {
  const fixture = await openRetirementFixture(await createScratch('purge-unqualified-owner-'), {
    seed: true, verified: () => false,
  });
  try {
    await move(fixture);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert(plan.blockers.some(item => item.code === 'permanent-deletion-unsupported'));
    assert.equal((await fixture.module.executePurge(plan)).status, 'rejected');
    assert.equal(fixture.owner.retireCalls, 0);
    assert.equal(fixture.owner.effectCalls, 0);
    assert(fixture.store.entry('quiet'));
  } finally { await fixture.close(); }
});

test('fixture purge erases only its frozen resource set and preserves native JSONL, Workspace and independent shared references', async t => {
  const root = await createScratch('purge-complete-');
  t.diagnostic(root);
  let fixture = await openRetirementFixture(root, { seed: true });
  const nativeLog = await transcript(fixture);
  const nativeAccounting = accounting(fixture);
  let plan;
  let result;
  try {
    await move(fixture);
    plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert.deepEqual(plan.blockers, []);
    assert(plan.binding && plan.manifest);
    result = await fixture.module.executePurge(plan);
    assert.equal(result.status, 'success');
    assert.equal(result.ownerState.phase, 'done');
    assert.equal(fixture.owner.authorizeCalls, 1);
    assert.equal(fixture.store.entry('quiet'), undefined);
    await assertResourcesRetired(fixture.owner, plan.binding.lifecycle);
    await assert.rejects(fixture.owner.appendFixtureResource(plan.binding.lifecycle, 'resurrection'), /exact lifecycle|retired|fenced/);
    assert.deepEqual(await transcript(fixture), nativeLog, 'fixture owner must never erase native JSONL');
    assert.deepEqual(accounting(fixture), nativeAccounting);
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    await fixture.close();
    fixture = await openRetirementFixture(root);
    assert.deepEqual(await fixture.module.executePurge(plan), result);
    assert.equal(fixture.owner.retireCalls, 0);
    await assertResourcesRetired(fixture.owner, plan.binding.lifecycle);
    assert.deepEqual(await transcript(fixture), nativeLog);
  } finally { await fixture.close(); }
});

test('duplicate purge, immutable request identity and old receipts do not erase a later entry or lifecycle', async () => {
  const fixture = await openRetirementFixture(await createScratch('purge-idempotent-'), { seed: true });
  try {
    await move(fixture);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    const results = await Promise.all(Array.from({ length: 12 }, () => fixture.module.executePurge(plan)));
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal(results[0].status, 'success');
    assert.equal(fixture.owner.retireCalls, 1);
    const changed = clone(plan);
    changed.manifest.resources[0].revision = 'different';
    await assert.rejects(fixture.module.executePurge(changed), error => error.code === 'bin/operation-id-reused');
    const lifecycle = await fixture.owner.createLifecycle('quiet');
    const next = await move(fixture);
    assert.notEqual(next.entryId, plan.expectedEntryId);
    const resources = await fixture.owner.resourceSnapshot(lifecycle);
    assert.deepEqual(await fixture.module.executePurge(plan), results[0]);
    assert.equal(fixture.store.entry('quiet').entryId, next.entryId);
    assert.deepEqual(await fixture.owner.resourceSnapshot(lifecycle), resources);
  } finally { await fixture.close(); }
});

test('operation identities are exclusive across archive and purge journals', async () => {
  const fixture = await openRetirementFixture(await createScratch('purge-cross-identity-'), { seed: true,
    ownerOptions: { pauseAt: 'fenced' } });
  try {
    await move(fixture, 'quiet', 'cross-archive-id');
    const collision = await fixture.module.preparePurge({ sessionId: 'quiet', operationId: 'cross-archive-id' });
    await assert.rejects(fixture.module.executePurge(collision), error => error.code === 'bin/operation-id-reused');
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet', operationId: 'cross-purge-id' });
    assert.equal((await fixture.module.executePurge(plan)).status, 'pending-recovery');
    const archive = await fixture.module.prepare({ action: 'bin', sessionId: 'sibling', operationId: plan.operationId });
    await assert.rejects(fixture.module.execute(archive), error => error.code === 'bin/operation-id-reused');
  } finally { await fixture.close(); }
});

test('activity and frozen manifest drift after preparation refuse deletion without stopping or erasing', async () => {
  const fixture = await openRetirementFixture(await createScratch('purge-stale-'), { seed: true });
  try {
    await move(fixture);
    const activePlan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    fixture.state.activity.set('quiet', ['turn', 'job']);
    const active = await fixture.module.executePurge(activePlan);
    assert.equal(active.status, 'rejected');
    assert.equal(active.reason, 'session-active');
    fixture.state.activity.delete('quiet');
    const drift = await fixture.module.preparePurge({ sessionId: 'quiet' });
    await fixture.owner.appendFixtureResource(drift.binding.lifecycle, 'new fixture turn after prepare');
    const conflict = await fixture.module.executePurge(drift);
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.reason, 'resource-scope-changed');
    assert.equal(fixture.owner.retireCalls, 0);
    assert.equal(fixture.owner.effectCalls, 0);
    assert.deepEqual(fixture.state.stops, []);
  } finally { await fixture.close(); }
});

test('authorization rechecks observed unarchive/rearchive while the owner is waiting', { timeout: 15000 }, async () => {
  const gate = latch();
  const fixture = await openRetirementFixture(await createScratch('purge-authorization-'), { seed: true,
    ownerOptions: { slowGate: { checkpoint: 'before-authorize', gate } } });
  let execution;
  try {
    await move(fixture);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    const before = await fixture.owner.resourceSnapshot(plan.binding.lifecycle);
    execution = observe(fixture.module.executePurge(plan));
    await gate.entered;
    await fixture.ctx.workspaceRegistry.unarchiveSession(SessionId('quiet'));
    await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
    gate.release();
    const outcome = await execution;
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.value.status, 'rejected');
    assert.equal(outcome.value.reason, 'archive-changed');
    assert.deepEqual(await fixture.owner.resourceSnapshot(plan.binding.lifecycle), before);
    assert.equal(fixture.owner.effectCalls, 0);
  } finally { gate.release(); await execution; await fixture.close(); }
});

for (const mode of ['pending', 'partial']) {
  test(`${mode} owner receipts hold the entry and refuse restore through reopen`, async () => {
    const root = await createScratch(`purge-${mode}-`);
    const ownerOptions = mode === 'pending' ? { pauseAt: 'fenced' } : { failResource: 'index' };
    let fixture = await openRetirementFixture(root, { seed: true, ownerOptions });
    let plan;
    try {
      await move(fixture);
      plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
      const result = await fixture.module.executePurge(plan);
      assert.equal(result.status, mode === 'pending' ? 'pending-recovery' : 'partial-failure');
      await assert.rejects(fixture.owner.appendFixtureResource(plan.binding.lifecycle, 'late writer'), /fenced/);
      await assert.rejects(fixture.owner.createLifecycle('quiet'), /fenced|fences|retired/);
      assert(fixture.store.entry('quiet'));
      assert.notEqual((await restore(fixture)).status, 'success');
      assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
      await fixture.close();
      fixture = await openRetirementFixture(root, { ownerOptions: { ...ownerOptions } });
      assert(fixture.store.entry('quiet'));
      assert.notEqual((await restore(fixture)).status, 'success');
      delete fixture.owner.options.pauseAt;
      delete fixture.owner.options.failResource;
      await fixture.module.reconcile();
      assert.equal((await fixture.module.getPurgeOperation(plan.operationId)).result.status, 'success');
      await assertResourcesRetired(fixture.owner, plan.binding.lifecycle);
    } finally { await fixture.close(); }
  });
}

test('an unavailable owner after a durable fence cannot release the entry or reopen it through restore', async () => {
  const root = await createScratch('purge-owner-unavailable-');
  let fixture = await openRetirementFixture(root, { seed: true, ownerOptions: { pauseAt: 'fenced' } });
  let plan;
  try {
    await move(fixture);
    plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert.equal((await fixture.module.executePurge(plan)).status, 'pending-recovery');
    await fixture.close();
    fixture = await openRetirementFixture(root, { ownerEnabled: false });
    assert(fixture.store.entry('quiet'));
    assert.notEqual((await restore(fixture)).status, 'success');
    assert.notEqual((await fixture.module.getPurgeOperation(plan.operationId)).phase, 'done');
    await fixture.close();
    fixture = await openRetirementFixture(root);
    assert.equal((await fixture.module.getPurgeOperation(plan.operationId)).result.status, 'success');
  } finally { await fixture.close(); }
});

const alteredReceipts = [
  ['different operation', state => { state.request.operationId = 'forged-operation'; }],
  ['different entry', state => { state.request.bin.entryId = randomUUID(); }],
  ['different authorization nonce', state => { state.authorizationId = randomUUID(); }],
  ['missing authorization nonce', state => { state.authorizationId = null; }],
  ['different store', state => {
    state.request.expected.storeId = 'forged-store';
    state.manifest.lifecycle.storeId = 'forged-store';
    state.manifest.capabilities.storeId = 'forged-store';
    state.request.manifestDigest = bin.retirementManifestDigest(state.manifest);
  }],
  ['different manifest', state => {
    state.manifest.resources[0].revision = 'forged-revision';
    state.request.manifestDigest = bin.retirementManifestDigest(state.manifest);
  }],
  ['missing resource', state => { state.resources.pop(); }],
  ['failed resource in done', state => { state.resources[0] = { ...state.resources[0], status: 'failed', reason: 'fixture-failed' }; }],
  ['wrong shared retention reason', state => { state.resources.find(item => item.status === 'retained').reason = 'coordination-identity'; }],
];
for (const [label, alter] of alteredReceipts) {
  test(`untrusted owner receipt (${label}) cannot commit Bin cleanup`, async () => {
    const root = await createScratch('purge-invalid-receipt-');
    let fixture = await openRetirementFixture(root, { seed: true, ownerWrapper(owner) {
      return override(owner, { async retire(request, authorize) {
        const state = clone(await owner.retire(request, authorize));
        alter(state);
        return state;
      } });
    } });
    let plan;
    try {
      await move(fixture);
      plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
      await assert.rejects(fixture.module.executePurge(plan));
      assert.equal(fixture.store.entry('quiet').entryId, plan.expectedEntryId);
      assert.notEqual(fixture.retirementStore.operation(plan.operationId).phase, 'done');
      await assert.rejects(fixture.module.list(), error => error.code === 'bin/recovery-required');
      await fixture.close();
      fixture = await openRetirementFixture(root);
      assert.equal((await fixture.module.getPurgeOperation(plan.operationId)).result.status, 'success',
        'only the original durable, matching owner receipt may finish metadata recovery');
    } finally { await fixture.close(); }
  });
}

test('an owner that bypasses Host authorization cannot create a successful receipt', async () => {
  const root = await createScratch('purge-no-authorization-');
  let fixture = await openRetirementFixture(root, { seed: true, ownerWrapper(owner) {
    return override(owner, { async retire(request) {
      return { schemaVersion: 1, request, manifest: await owner.prepare(request.expected),
        authorizationId: randomUUID(), phase: 'fenced', reason: null, resources: [] };
    } });
  } });
  let plan;
  try {
    await move(fixture);
    plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    const before = await fixture.owner.resourceSnapshot(plan.binding.lifecycle);
    await assert.rejects(fixture.module.executePurge(plan), /authorization/);
    assert(fixture.store.entry('quiet'));
    assert.deepEqual(await fixture.owner.resourceSnapshot(plan.binding.lifecycle), before);
    await fixture.close();
    fixture = await openRetirementFixture(root);
    const operation = await fixture.module.getPurgeOperation(plan.operationId);
    assert.equal(operation.result.status, 'conflict');
    assert.equal(operation.result.reason, 'interrupted');
    assert(fixture.store.entry('quiet'));
  } finally { await fixture.close(); }
});

for (const regression of ['phase', 'acknowledged-resource']) {
  test(`owner recovery cannot regress a durable ${regression}`, async () => {
    const root = await createScratch('purge-owner-regression-');
    const ownerOptions = regression === 'phase' ? { pauseAt: 'quiesced' } : { failResource: 'index' };
    let fixture = await openRetirementFixture(root, { seed: true, ownerOptions, ownerWrapper(owner) {
      return override(owner, { async getOperation(operationId) {
        const state = await owner.getOperation(operationId);
        if (state && !['done', 'rejected', 'conflict'].includes(state.phase)) {
          if (regression === 'phase') state.phase = 'fenced';
          else state.resources = [];
        }
        return state;
      } });
    } });
    let plan;
    try {
      await move(fixture);
      plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
      assert(['pending-recovery', 'partial-failure'].includes((await fixture.module.executePurge(plan)).status));
      await assert.rejects(fixture.module.reconcile(), /regressed|acknowledged/);
      assert(fixture.store.entry('quiet'));
      assert.notEqual(fixture.retirementStore.operation(plan.operationId).phase, 'done');
      await fixture.close();
      fixture = await openRetirementFixture(root);
      assert.equal((await fixture.module.getPurgeOperation(plan.operationId)).result.status, 'success');
      assert.equal(fixture.owner.retireCalls, 0);
    } finally { await fixture.close(); }
  });
}

test('ordinary prepare, list and receipt reads never recover or erase pending fixture resources', async () => {
  const fixture = await openRetirementFixture(await createScratch('purge-read-only-'), { seed: true,
    ownerOptions: { pauseAt: 'fenced' } });
  try {
    await move(fixture);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert.equal((await fixture.module.executePurge(plan)).status, 'pending-recovery');
    delete fixture.owner.options.pauseAt;
    const before = await fixture.owner.resourceSnapshot(plan.binding.lifecycle);
    const recoverCalls = fixture.owner.recoverCalls;
    const effectCalls = fixture.owner.effectCalls;
    await fixture.module.list();
    await fixture.module.operations();
    await fixture.module.getPurgeOperation(plan.operationId);
    await fixture.module.purgeOperations();
    await fixture.module.preparePurge({ sessionId: 'quiet' });
    await fixture.module.prepare({ action: 'restore', sessionId: 'quiet' });
    assert.equal(fixture.owner.recoverCalls, recoverCalls);
    assert.equal(fixture.owner.effectCalls, effectCalls);
    assert.deepEqual(await fixture.owner.resourceSnapshot(plan.binding.lifecycle), before);
    await fixture.module.reconcile();
    assert.equal((await fixture.module.getPurgeOperation(plan.operationId)).result.status, 'success');
  } finally { await fixture.close(); }
});

for (const misleading of ['missing', 'refusal']) {
  test(`unknown recovery acknowledgement followed by owner ${misleading} cannot remove the durable guard`, async () => {
    const root = await createScratch('purge-observed-recovery-');
    let fixture = await openRetirementFixture(root, { seed: true, ownerOptions: { pauseAt: 'fenced' }, ownerWrapper(owner) {
      return override(owner, { async retire(request, authorize) {
        await owner.retire(request, authorize);
        throw new Error('injected lost initial owner reply');
      } });
    } });
    let plan;
    try {
      await move(fixture);
      plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
      await assert.rejects(fixture.module.executePurge(plan), error => containsFailure(error, 'lost initial owner reply'));
      assert.equal(fixture.retirementStore.operation(plan.operationId).ownerState, null);
      await fixture.close();
      fixture = await openRetirementFixture(root, { skipReconcile: true, ownerWrapper(owner) {
        return override(owner, { async recover(operationId) {
          await owner.recover(operationId);
          throw new Error('injected lost recovery acknowledgement');
        } });
      } });
      await assert.rejects(fixture.module.reconcile(), error => containsFailure(error, 'lost recovery acknowledgement'));
      assert.equal(fixture.retirementStore.operation(plan.operationId).ownerState.phase, 'fenced',
        'the matching observed owner state must be durable before calling recover');
      assert(fixture.store.entry('quiet'));
      await fixture.close();
      fixture = await openRetirementFixture(root, { skipReconcile: true, ownerWrapper(owner) {
        return override(owner, { async getOperation(operationId) {
          if (misleading === 'missing') return null;
          const state = await owner.getOperation(operationId);
          return { ...state, authorizationId: null, phase: 'rejected', reason: 'fixture-invalid-late-refusal', resources: [] };
        } });
      } });
      await assert.rejects(fixture.module.reconcile());
      assert(fixture.store.entry('quiet'));
      assert.notEqual(fixture.retirementStore.operation(plan.operationId).phase, 'done');
      await fixture.close();
      fixture = await openRetirementFixture(root);
      assert.equal((await fixture.module.getPurgeOperation(plan.operationId)).result.status, 'success');
      assert.equal(fixture.owner.retireCalls, 0);
    } finally { await fixture.close(); }
  });
}

for (const nonce of ['forged', 'missing']) {
  test(`a refused authorization stamp cannot admit an owner with a ${nonce} handoff nonce after reopen`, async () => {
    const root = await createScratch('purge-refused-handoff-');
    let fixture;
    let invalidated = false;
    fixture = await openRetirementFixture(root, { seed: true, purgeStoreWrapper(store) {
      return override(store, { async putOperation(operation) {
        await store.putOperation(operation);
        if (!invalidated && operation.phase === 'authorizing') {
          invalidated = true;
          await fixture.ctx.workspaceRegistry.unarchiveSession(SessionId('quiet'));
          await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
        }
      } });
    }, ownerWrapper(owner) {
      return override(owner, { async retire(request, authorize) {
        const manifest = await owner.prepare(request.expected);
        const grant = await authorize();
        assert.equal(grant.authorized, false);
        const state = { schemaVersion: 1, request, manifest,
          authorizationId: nonce === 'forged' ? randomUUID() : null,
          phase: 'fenced', reason: null, resources: [] };
        // A raw invalid fixture-owner record also tests fail-closed open. The
        // shipped SDK admits invalid put; consumer/product stores must not.
        await owner.journalDomain.table('operations').put(request.operationId, {
          schemaVersion: 1, state, blockedReason: null,
          participants: manifest.capabilities.participants.map(participant => ({ ...participant,
            fenced: false, quiesced: false, converged: false })),
          lifecycleQuiesced: false, lifecycleFinalized: false,
        });
        return state;
      } });
    } });
    let plan;
    try {
      await move(fixture);
      plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
      const before = await fixture.owner.resourceSnapshot(plan.binding.lifecycle);
      await assert.rejects(fixture.module.executePurge(plan));
      assert.equal(invalidated, true);
      assert.equal(fixture.retirementStore.operation(plan.operationId).phase, 'authorizing');
      assert(fixture.store.entry('quiet'));
      assert.deepEqual(await fixture.owner.resourceSnapshot(plan.binding.lifecycle), before);
      await fixture.close();
      await assert.rejects(openRetirementFixture(root), undefined,
        'neither a forged nonce nor a malformed owner fence may turn a refused callback into authorization');
    } finally { await fixture.close(); }
  });
}

test('authorization is single-use even when an owner catches the duplicate call rejection', async () => {
  const root = await createScratch('purge-duplicate-callback-');
  let duplicateRejected = false;
  let fixture = await openRetirementFixture(root, { seed: true, ownerWrapper(owner) {
    return override(owner, { retire(request, authorize) {
      return owner.retire(request, async () => {
        const grant = await authorize();
        await assert.rejects(authorize(), /single-use/);
        duplicateRejected = true;
        return grant;
      });
    } });
  } });
  let plan;
  try {
    await move(fixture);
    plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    await assert.rejects(fixture.module.executePurge(plan), error => containsFailure(error, 'single-use'));
    assert.equal(duplicateRejected, true);
    assert(fixture.store.entry('quiet'));
    assert.notEqual(fixture.retirementStore.operation(plan.operationId).phase, 'done');
    await assert.rejects(fixture.module.list(), error => error.code === 'bin/recovery-required');
    await fixture.close();
    fixture = await openRetirementFixture(root);
    assert.equal((await fixture.module.getPurgeOperation(plan.operationId)).result.status, 'success');
    assert.equal(fixture.owner.retireCalls, 0);
  } finally { await fixture.close(); }
});

test('a retained authorization callback is revoked after owner settlement and cannot mutate a completed journal', async () => {
  let retainedAuthorize;
  const fixture = await openRetirementFixture(await createScratch('purge-late-callback-'), { seed: true, ownerWrapper(owner) {
    return override(owner, { async retire(request, authorize) {
      retainedAuthorize = authorize;
      return owner.retire(request, authorize);
    } });
  } });
  try {
    await move(fixture);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert.equal((await fixture.module.executePurge(plan)).status, 'success');
    const before = await fixture.module.getPurgeOperation(plan.operationId);
    const effects = fixture.owner.effectCalls;
    await assert.rejects(retainedAuthorize(), /revoked/);
    assert.deepEqual(await fixture.module.getPurgeOperation(plan.operationId), before);
    assert.equal(fixture.owner.effectCalls, effects);
    assert.deepEqual(await fixture.module.list(), []);
  } finally { await fixture.close(); }
});

test('owner settlement joins a started unawaited authorization before completion or lease release', { timeout: 15000 }, async () => {
  const root = await createScratch('purge-unawaited-callback-');
  const gate = latch();
  let pendingGrant;
  let execution;
  let settled = false;
  const fixture = await openRetirementFixture(root, { seed: true, purgeStoreWrapper(store) {
    return override(store, { async putOperation(operation) {
      await store.putOperation(operation);
      if (operation.phase === 'authorizing') await gate.pause();
    } });
  }, ownerWrapper(owner) {
    return override(owner, { async retire(request, authorize) {
      const manifest = await owner.prepare(request.expected);
      pendingGrant = authorize();
      void pendingGrant.catch(() => {});
      await gate.entered;
      return { schemaVersion: 1, request, manifest, authorizationId: null,
        phase: 'rejected', reason: 'fixture-settled-without-awaiting-authorization', resources: [] };
    } });
  } });
  try {
    await move(fixture);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    execution = observe(fixture.module.executePurge(plan)).then(value => { settled = true; return value; });
    await gate.entered;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'the module must still await the started callback');
    assert.equal(fixture.retirementStore.operation(plan.operationId).phase, 'authorizing');
    await assert.rejects(bin.acquireBinLease(join(root, 'coordination')), error => error.code === 'bin/lease-unavailable');
    gate.release();
    const outcome = await execution;
    assert(outcome.error && containsFailure(outcome.error, 'revoked'));
    await assert.rejects(pendingGrant, /revoked/);
    assert(fixture.store.entry('quiet'));
    assert.equal(fixture.owner.effectCalls, 0);
  } finally { gate.release(); await execution; await fixture.close(); }
  const release = await bin.acquireBinLease(join(root, 'coordination'));
  await release();
});

for (const source of ['owner', 'sidecar']) {
  test(`unexpected ${source} SessionBinError cannot masquerade as a recoverable business refusal`, async () => {
    const root = await createScratch('purge-external-business-error-');
    let faulted = false;
    const errorText = `fixture ${source} unknown acknowledgement loss`;
    let fixture = await openRetirementFixture(root, { seed: true,
      ...(source === 'owner' ? { ownerWrapper(owner) {
        return override(owner, { async retire(request, authorize) {
          await owner.retire(request, authorize);
          throw new bin.SessionBinError('bin/operation-id-reused', errorText);
        } });
      } } : { purgeStoreWrapper(store) {
        return override(store, { async putOperation(operation) {
          await store.putOperation(operation);
          if (!faulted && operation.phase === 'authorizing') {
            faulted = true;
            throw new bin.SessionBinError('bin/operation-id-reused', errorText);
          }
        } });
      } }) });
    let plan;
    try {
      await move(fixture);
      plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
      await assert.rejects(fixture.module.executePurge(plan), error => containsFailure(error, errorText));
      assert(fixture.store.entry('quiet'));
      assert.notEqual(fixture.retirementStore.operation(plan.operationId).phase, 'done');
      await assert.rejects(fixture.module.list(), error => error.code === 'bin/recovery-required');
      await fixture.close();
      fixture = await openRetirementFixture(root);
      const result = (await fixture.module.getPurgeOperation(plan.operationId)).result;
      assert.equal(result.status, source === 'owner' ? 'success' : 'conflict');
      assert.equal(fixture.owner.retireCalls, 0);
    } finally { await fixture.close(); }
  });
}

test('purge admission snapshots the caller plan and response mutations cannot affect durable receipts', async () => {
  const fixture = await openRetirementFixture(await createScratch('purge-snapshots-'), { seed: true });
  try {
    await move(fixture);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    const original = clone(plan);
    const executing = fixture.module.executePurge(plan);
    plan.sessionId = 'sibling';
    plan.manifest.resources[0].revision = 'caller-mutated';
    const result = await executing;
    assert.equal(result.status, 'success');
    result.ownerState.request.operationId = 'mutated-result';
    assert.equal((await fixture.module.getPurgeOperation(original.operationId)).result.ownerState.request.operationId, original.operationId);
    assert.equal(fixture.owner.retireCalls, 1);
  } finally { await fixture.close(); }
});

test('loss of the Host acknowledgement after owner-done durability reopens without erasing twice', async () => {
  const root = await createScratch('purge-owner-done-io-');
  let thrown = false;
  let fixture = await openRetirementFixture(root, { seed: true, purgeStoreWrapper(store) {
    return override(store, { async putOperation(operation) {
      await store.putOperation(operation);
      if (!thrown && operation.ownerState?.phase === 'done' && operation.phase !== 'done') {
        thrown = true;
        throw new Error('injected acknowledgement loss after owner-done journal commit');
      }
    } });
  } });
  let plan;
  try {
    await move(fixture);
    plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    await assert.rejects(fixture.module.executePurge(plan), /acknowledgement loss/);
    assert(fixture.store.entry('quiet'));
    assert.equal(fixture.retirementStore.operation(plan.operationId).ownerState.phase, 'done');
    await fixture.close();
    fixture = await openRetirementFixture(root, { ownerEnabled: false });
    assert.equal((await fixture.module.getPurgeOperation(plan.operationId)).result.status, 'success');
    assert.equal(fixture.owner.retireCalls, 0);
    assert.equal(fixture.owner.recoverCalls, 0);
    await assertResourcesRetired(fixture.owner, plan.binding.lifecycle);
  } finally { await fixture.close(); }
});

test('actual process termination recovers every fixture purge durability boundary', { timeout: 90000 }, async t => {
  for (const checkpoint of ['plugin-intent', 'plugin-authorizing', 'owner-fenced', 'resource-effect', 'owner-done', 'plugin-entry', 'plugin-done']) {
    const root = await createScratch(`purge-crash-${checkpoint}-`);
    t.diagnostic(root);
    let fixture = await openRetirementFixture(root, { seed: true });
    await move(fixture);
    const nativeLog = await transcript(fixture);
    const nativeAccounting = accounting(fixture);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet', operationId: `crash-${checkpoint}` });
    await fixture.close();
    await killAt(root, checkpoint, plan);
    fixture = await openRetirementFixture(root);
    try {
      const operation = await fixture.module.getPurgeOperation(plan.operationId);
      assert.equal(operation.phase, 'done', checkpoint);
      if (['plugin-intent', 'plugin-authorizing'].includes(checkpoint)) {
        assert.equal(operation.result.status, 'conflict');
        assert.equal(operation.result.reason, 'interrupted');
        assert(fixture.store.entry('quiet'));
        assert.equal(fixture.owner.retireCalls, 0);
      } else {
        assert.equal(operation.result.status, 'success', checkpoint);
        assert.equal(fixture.store.entry('quiet'), undefined);
        await assertResourcesRetired(fixture.owner, plan.binding.lifecycle);
      }
      assert.deepEqual(await fixture.module.executePurge(plan), operation.result);
      assert.equal(fixture.owner.retireCalls, 0, 'recovery must never issue a new retire request');
      assert.deepEqual(await transcript(fixture), nativeLog);
      assert.deepEqual(accounting(fixture), nativeAccounting);
    } finally { await fixture.close(); }
  }
});

test('purge close drains admitted owner work and preserves the shared lifetime lease', { timeout: 15000 }, async () => {
  const root = await createScratch('purge-close-');
  const gate = latch();
  const fixture = await openRetirementFixture(root, { seed: true,
    ownerOptions: { slowGate: { checkpoint: 'before-authorize', gate } } });
  let execution;
  let closing;
  try {
    await move(fixture);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    execution = observe(fixture.module.executePurge(plan));
    await gate.entered;
    closing = fixture.module.close();
    await assert.rejects(fixture.module.preparePurge({ sessionId: 'quiet' }), error => error.code === 'bin/closed');
    await assert.rejects(bin.acquireBinLease(join(root, 'coordination')), error => error.code === 'bin/lease-unavailable');
    await fixture.ctx.workspaceRegistry.unarchiveSession(SessionId('quiet'));
    await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
    gate.release();
    assert.equal((await execution).value.status, 'rejected');
    await closing;
    await fixture.close();
    const release = await bin.acquireBinLease(join(root, 'coordination'));
    await release();
  } finally { gate.release(); await execution; await closing; await fixture.close(); }
});
