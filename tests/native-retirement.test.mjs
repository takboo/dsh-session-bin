import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as product from '../dist/index.js';
import { createScratch, openFixture, transcript, accounting } from './helpers/fixture.mjs';
import { openRetirementFixture, latch, override } from './helpers/retirement-owner.mjs';
import { assertCrashExit, sessionBinPlugin } from './helpers/platform-fixture.mjs';

const archive = fixture => fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
const unarchive = fixture => fixture.ctx.workspaceRegistry.unarchiveSession(SessionId('quiet'));
const open = (root, options = {}) => openRetirementFixture(root, { ...options, nativeArchive: true });
const observe = promise => promise.then(value => ({ value }), error => ({ error }));

async function assertRetired(owner, plan) {
  const resources = await owner.resourceSnapshot(plan.binding.lifecycle);
  for (const { resource, record } of resources) {
    if (['erase', 'release-reference'].includes(resource.disposition)) assert.equal(record, null);
    else assert(record);
    if (resource.disposition === 'retain-shared') {
      assert.deepEqual(record.references, resource.retention.retainedBy.map(key => key.lifecycleId));
    }
  }
}

test('native observation is inert; explicit preparation binds an exact owner and frozen manifest without a legacy Bin entry', async t => {
  const root = await createScratch('native-purge-complete-'); t.diagnostic(root);
  let fixture = await open(root, { seed: true });
  try {
    await archive(fixture);
    const before = await transcript(fixture); const positions = accounting(fixture);
    const [entry] = await fixture.module.list();
    await fixture.module.reconcile();
    assert.equal(fixture.retirementStore.binding(entry.entryId), undefined);
    assert.equal(fixture.owner.retireCalls, 0); assert.equal(fixture.owner.effectCalls, 0);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert.equal(plan.schemaVersion, 2); assert.deepEqual(plan.blockers, []);
    assert.equal(plan.binding.target, 'native-archive'); assert.equal(plan.binding.entryVersion, 2);
    assert.equal(plan.expectedEntryId, entry.entryId);
    assert.equal(fixture.ctx.storageDomain.get('session_bin'), undefined);
    assert.equal(fixture.owner.effectCalls, 0);
    const original = structuredClone(plan);
    const executing = fixture.module.executePurge(plan);
    plan.manifest.resources[0].revision = 'caller mutation';
    const result = await executing;
    assert.equal(result.status, 'success'); assert.equal(result.ownerState.request.bin.kind, 'native-archive');
    assert.equal(fixture.store.entry('quiet'), undefined);
    await assertRetired(fixture.owner, original);
    assert.deepEqual(await transcript(fixture), before); assert.deepEqual(accounting(fixture), positions);
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    await fixture.close(); fixture = await open(root);
    const current = (await fixture.module.list())[0];
    assert.notEqual(current.entryId, entry.entryId);
    assert.deepEqual(await fixture.module.executePurge(original), result);
    assert.equal(fixture.store.entry('quiet').entryId, current.entryId);
    assert.equal(fixture.owner.retireCalls, 0); assert.equal(fixture.owner.effectCalls, 0);
  } finally { await fixture.close(); }
});

for (const qualification of ['absent', 'self-report', 'legacy-only']) test(`native owner ${qualification} cannot mint deletion authority`, async () => {
  const fixture = await open(await createScratch('native-purge-unqualified-'), { seed: true,
    ...(qualification === 'absent' ? { ownerEnabled: false }
      : qualification === 'legacy-only' ? { legacyQualificationOnly: true } : { verified: () => false }) });
  try {
    await archive(fixture);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert.equal(plan.binding, null); assert.equal(plan.manifest, null);
    assert.equal(plan.blockers[0].code, 'permanent-deletion-unsupported');
    assert.equal((await fixture.module.executePurge({ ...plan, blockers: [] })).reason, 'permanent-deletion-unsupported');
    assert.equal(fixture.owner.effectCalls, 0);
  } finally { await fixture.close(); }
});

for (const change of ['unarchive', 'aba', 'lifecycle', 'activity', 'manifest', 'descriptor']) {
  test(`native purge checks ${change} again after preparation`, async () => {
    let descriptorChanged = false;
    const fixture = await open(await createScratch(`native-purge-${change}-`), { seed: true,
      ownerWrapper: owner => override(owner, { async capabilities() {
        const caps = await owner.capabilities();
        return descriptorChanged ? { ...caps, providerId: 'other-provider' } : caps;
      } }) });
    try {
      await archive(fixture);
      const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
      if (change === 'unarchive' || change === 'aba') { await unarchive(fixture); if (change === 'aba') await archive(fixture); }
      else if (change === 'lifecycle') await fixture.owner.createLifecycle('quiet');
      else if (change === 'activity') fixture.state.activity.set('quiet', ['turn']);
      else if (change === 'manifest') await fixture.owner.appendFixtureResource(plan.binding.lifecycle, 'scope changed');
      else descriptorChanged = true;
      const result = await fixture.module.executePurge({ ...plan, blockers: [] });
      assert.notEqual(result.status, 'success'); assert.equal(fixture.owner.effectCalls, 0);
      assert.equal(fixture.owner.retireCalls, 0); assert.deepEqual(fixture.state.stops, []);
      if (change === 'aba') assert.notEqual((await fixture.module.list())[0].entryId, plan.expectedEntryId);
    } finally { await fixture.close(); }
  });
}

for (const boundary of ['intent', 'authorizing', 'before-authorize']) {
  test(`observed ABA during native ${boundary} wait refuses authorization`, { timeout: 15000 }, async () => {
    const gate = latch();
    const fixture = await open(await createScratch(`native-purge-wait-${boundary}-`), { seed: true,
      ...(boundary === 'before-authorize' ? { ownerOptions: { slowGate: { checkpoint: boundary, gate } } }
        : { purgeStoreWrapper: store => override(store, { async putOperation(operation) {
          await store.putOperation(operation); if (operation.phase === boundary) await gate.pause();
        } }) }) });
    let execution;
    try {
      await archive(fixture);
      const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
      execution = observe(fixture.module.executePurge(plan)); await gate.entered;
      await unarchive(fixture); await archive(fixture); gate.release();
      const outcome = await execution;
      assert.equal(outcome.error, undefined); assert.equal(outcome.value.status, 'rejected');
      assert.equal(outcome.value.reason, 'archive-changed'); assert.equal(fixture.owner.effectCalls, 0);
      assert.equal(outcome.value.ownerState.authorizationId, null);
    } finally { gate.release(); await execution; await fixture.close(); }
  });
}

test('native preparation rechecks the fixed observation after an owner inventory wait', { timeout: 15000 }, async () => {
  const gate = latch();
  const fixture = await open(await createScratch('native-purge-prepare-wait-'), { seed: true,
    ownerWrapper: owner => override(owner, { async prepare(expected) { const manifest = await owner.prepare(expected); await gate.pause(); return manifest; } }) });
  let preparation;
  try {
    await archive(fixture); preparation = fixture.module.preparePurge({ sessionId: 'quiet' }); await gate.entered;
    await unarchive(fixture); await archive(fixture); gate.release();
    const plan = await preparation;
    assert.equal(plan.blockers[0].code, 'archive-changed'); assert.equal(fixture.owner.effectCalls, 0);
    assert.notEqual((await fixture.module.list())[0].entryId, plan.expectedEntryId);
  } finally { gate.release(); await preparation; await fixture.close(); }
});

for (const mode of ['pending', 'partial', 'unavailable']) test(`native ${mode} guard survives reopen; queries do not advance resource deletion`, async () => {
  const root = await createScratch(`native-purge-guard-${mode}-`);
  const ownerOptions = mode === 'partial' ? { failResource: 'index' } : { pauseAt: 'fenced' };
  let fixture = await open(root, { seed: true, ownerOptions });
  try {
    await archive(fixture); const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    const result = await fixture.module.executePurge(plan);
    assert.equal(result.status, mode === 'partial' ? 'partial-failure' : 'pending-recovery');
    const effects = fixture.owner.effectCalls;
    await fixture.module.list(); await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert.equal(fixture.owner.recoverCalls, 0); assert.equal(fixture.owner.effectCalls, effects);
    await fixture.close(); fixture = await open(root, { ownerOptions, ...(mode === 'unavailable' ? { ownerEnabled: false } : {}) });
    const restore = await fixture.module.prepare({ action: 'unarchive', sessionId: 'quiet' });
    assert.equal((await fixture.module.execute(restore)).reason, 'pending-deletion');
    assert.equal(fixture.store.entry('quiet').entryId, plan.expectedEntryId);
    if (mode !== 'unavailable') {
      delete fixture.owner.options.pauseAt; delete fixture.owner.options.failResource;
      await fixture.module.list(); await fixture.module.getPurgeOperation(plan.operationId);
      assert.equal(fixture.owner.effectCalls, 0);
      await fixture.module.reconcilePurge();
      assert.equal((await fixture.module.getPurgeOperation(plan.operationId)).result.status, 'success');
    }
  } finally { await fixture.close(); }
});

test('pending native guard keeps exact metadata across observed member exit and ABA without hanging list', { timeout: 15000 }, async () => {
  const fixture = await open(await createScratch('native-purge-pending-aba-'), { seed: true, ownerOptions: { pauseAt: 'fenced' } });
  try {
    await archive(fixture); const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    await fixture.module.executePurge(plan); await unarchive(fixture);
    assert.deepEqual(await fixture.module.list(), []);
    assert.equal(fixture.store.entry('quiet').entryId, plan.expectedEntryId);
    await archive(fixture); assert.equal((await fixture.module.list())[0].entryId, plan.expectedEntryId);
    const next = await fixture.module.preparePurge({ sessionId: 'quiet' });
    assert(next.blockers.length); assert.equal(fixture.owner.effectCalls, 0);
    delete fixture.owner.options.pauseAt; await fixture.module.reconcilePurge();
    assert.notEqual((await fixture.module.list())[0].entryId, plan.expectedEntryId);
  } finally { await fixture.close(); }
});

test('native and legacy bindings are not interchangeable and operation IDs cannot cross unarchive or purge', async () => {
  const fixture = await open(await createScratch('native-purge-protocol-'), { seed: true });
  try {
    await archive(fixture); const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    const forged = structuredClone(plan); forged.schemaVersion = 1;
    assert.equal(product.purgePlanSchema.safeParse(forged).success, false);
    assert.equal(product.retirementRequestSchema.safeParse({ operationId: randomUUID(), expected: plan.binding.lifecycle,
      bin: { entryId: plan.expectedEntryId, entryVersion: 2 }, manifestDigest: product.retirementManifestDigest(plan.manifest) }).success, false);
    const result = await fixture.module.executePurge(plan);
    const cross = structuredClone(plan); cross.schemaVersion = 1;
    cross.binding = { ...cross.binding, schemaVersion: 1, entryVersion: 1 }; delete cross.binding.target;
    await assert.rejects(fixture.module.executePurge(cross), error => error.code === 'bin/operation-id-reused');
    await assert.rejects(fixture.module.prepare({ action: 'unarchive', sessionId: 'quiet', operationId: result.operationId }), error => error.code === 'bin/operation-id-reused');
    await assert.rejects(fixture.module.preparePurge({ sessionId: 'quiet', operationId: result.operationId }), error => error.code === 'bin/operation-id-reused');
  } finally { await fixture.close(); }
});

for (const boundary of ['binding', 'intent', 'owner-done']) test(`unknown native ${boundary} acknowledgement pauses the entire module and reopens conservatively`, async () => {
  const root = await createScratch(`native-purge-io-${boundary}-`); let injected = false;
  let fixture = await open(root, { seed: true, purgeStoreWrapper: store => override(store, {
    async putBinding(binding) { await store.putBinding(binding); if (boundary === 'binding' && !injected) { injected = true; throw false; } },
    async putOperation(operation) { await store.putOperation(operation);
      if (!injected && (boundary === 'intent' && operation.phase === 'intent'
        || boundary === 'owner-done' && operation.ownerState?.phase === 'done' && operation.phase !== 'done')) {
        injected = true; throw new product.SessionBinError('bin/operation-id-reused', 'unknown commit acknowledgement');
      }
    },
  }) });
  let plan;
  try {
    await archive(fixture);
    if (boundary === 'binding') await assert.rejects(fixture.module.preparePurge({ sessionId: 'quiet' }));
    else { plan = await fixture.module.preparePurge({ sessionId: 'quiet' }); await assert.rejects(fixture.module.executePurge(plan)); }
    await assert.rejects(fixture.module.list(), error => error.code === 'bin/recovery-required');
    await fixture.close(); fixture = await open(root, { ...(boundary === 'owner-done' ? { ownerEnabled: false } : {}) });
    if (plan) assert.equal((await fixture.module.getPurgeOperation(plan.operationId)).result.status, boundary === 'intent' ? 'conflict' : 'success');
    assert.equal(fixture.owner.retireCalls, 0); assert.equal(fixture.owner.recoverCalls, 0);
  } finally { await fixture.close(); }
});

test('native purge close drains authorization and holds the lifetime lease through observed invalidation', { timeout: 15000 }, async () => {
  const gate = latch(); const root = await createScratch('native-purge-close-');
  const fixture = await open(root, { seed: true, ownerOptions: { slowGate: { checkpoint: 'before-authorize', gate } } });
  let execution; let closing;
  try {
    await archive(fixture); const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    execution = observe(fixture.module.executePurge(plan)); await gate.entered;
    closing = fixture.module.close();
    await assert.rejects(fixture.module.preparePurge({ sessionId: 'quiet' }), error => error.code === 'bin/closed');
    await assert.rejects(product.acquireBinLease(join(root, 'coordination')), error => error.code === 'bin/lease-unavailable');
    await unarchive(fixture); await archive(fixture); gate.release();
    assert.equal((await execution).value.status, 'rejected'); await closing; await fixture.close();
    const release = await product.acquireBinLease(join(root, 'coordination')); await release();
  } finally { gate.release(); await execution; await closing; await fixture.close(); }
});

for (const protocol of ['legacy', 'native']) test(`production loads existing observations beside ${protocol} pending deletion and closes the shared journal after both consumers drain`, { timeout: 15000 }, async () => {
  const root = await createScratch(`native-purge-shared-${protocol}-`);
  let fixture = await openRetirementFixture(root, { seed: true, nativeArchive: protocol === 'native', ownerOptions: { pauseAt: 'fenced' } });
  let plan;
  try {
    if (protocol === 'native') await archive(fixture);
    else await fixture.module.execute(await fixture.module.prepare({ action: 'bin', sessionId: 'quiet' }));
    plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    await fixture.module.executePurge(plan); await fixture.close();
    fixture = await openFixture(root, { plugin: false });
    const domain = await fixture.ctx.storageDomain.open(product.archiveDomainSpec);
    const store = new product.DomainArchiveStore(domain);
    if (!store.entry('quiet')) await store.putEntry({ schemaVersion: 2, sessionId: 'quiet', entryId: randomUUID() });
    const expected = store.entry('quiet').entryId; await domain.close();
    await fixture.mount(sessionBinPlugin(root), { coordinationDirectory: join(root, 'coordination') });
    const service = fixture.ctx.get('sessionBin');
    assert.equal((await service.list())[0].entryId, expected);
    const restore = await service.prepare({ action: 'unarchive', sessionId: 'quiet' });
    assert.equal((await service.execute(restore)).reason, 'pending-deletion');
    assert.notEqual((await service.getPurgeOperation(plan.operationId)).phase, 'done');
    await fixture.close();
    const release = await product.acquireBinLease(join(root, 'coordination')); await release();
  } finally { await fixture.close(); }
});

for (const originalTarget of ['legacy', 'native']) test(`pending ${originalTarget} retirement cannot be recovered using the other target consumer`, async () => {
  const root = await createScratch(`native-purge-wrong-consumer-${originalTarget}-`);
  let fixture = await openRetirementFixture(root, { seed: true, nativeArchive: originalTarget === 'native', ownerOptions: { pauseAt: 'fenced' } });
  try {
    if (originalTarget === 'native') await archive(fixture);
    else await fixture.module.execute(await fixture.module.prepare({ action: 'bin', sessionId: 'quiet' }));
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    await fixture.module.executePurge(plan); await fixture.close();
    fixture = await openRetirementFixture(root, { nativeArchive: originalTarget !== 'native' });
    await assert.rejects(fixture.module.executePurge(plan), error => error.code === 'bin/deletion-target-mismatch');
    assert.equal(fixture.owner.recoverCalls, 0); assert.equal(fixture.owner.effectCalls, 0);
    assert.notEqual((await fixture.module.getPurgeOperation(plan.operationId)).phase, 'done');
  } finally { await fixture.close(); }
});

test('one accepted reconciliation drains legacy and native journals even when close starts during the first hook', { timeout: 15000 }, async () => {
  const gate = latch(); let hooked = false;
  const fixture = await open(await createScratch('native-purge-reconcile-close-'), { seed: true, skipReconcile: true,
    moduleOptions: { reconcileLegacyPurge: async () => { hooked = true; await gate.pause(); return { completed: [], pending: ['legacy-pending'] }; } } });
  let recovering; let closing;
  try {
    recovering = observe(fixture.module.reconcilePurge()); await gate.entered;
    closing = fixture.module.close();
    await assert.rejects(fixture.module.list(), error => error.code === 'bin/closed');
    gate.release(); const result = await recovering;
    assert.equal(hooked, true); assert.equal(result.error, undefined);
    assert.deepEqual(result.value, { completed: [], pending: ['legacy-pending'] });
    await closing;
  } finally { gate.release(); await recovering; await closing; await fixture.close(); }
});

async function killAt(root, checkpoint, plan) {
  const worker = fork(new URL('./helpers/retirement-worker.mjs', import.meta.url), [root, checkpoint, JSON.stringify(plan)], { silent: true });
  let stderr = ''; let sent; let timedOut = false;
  worker.stdout.resume(); worker.stderr.on('data', data => { stderr += data; });
  worker.on('message', message => { sent = message.plan; });
  const timeout = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, 20000);
  try {
    const [code, signal] = await once(worker, 'exit');
    assert.equal(timedOut, false, stderr); assertCrashExit(root, checkpoint, code, signal, stderr);
    assert.deepEqual(sent, plan);
  } finally { clearTimeout(timeout); if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await once(worker, 'exit'); } }
}

test('actual SIGKILL recovers native-target retirement at all seven durability boundaries without replaying native changes', { timeout: 90000 }, async t => {
  for (const boundary of ['plugin-intent', 'plugin-authorizing', 'owner-fenced', 'resource-effect', 'owner-done', 'plugin-entry', 'plugin-done']) {
    const root = await createScratch(`native-purge-crash-${boundary}-`); t.diagnostic(root);
    let fixture = await open(root, { seed: true }); await archive(fixture);
    const log = await transcript(fixture); const positions = accounting(fixture);
    const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
    await fixture.close(); await killAt(root, boundary, plan); fixture = await open(root);
    try {
      const operation = await fixture.module.getPurgeOperation(plan.operationId);
      assert.equal(operation.schemaVersion, 2); assert.equal(operation.phase, 'done');
      assert.equal(operation.result.status, ['plugin-intent', 'plugin-authorizing'].includes(boundary) ? 'conflict' : 'success');
      assert.deepEqual(await fixture.module.executePurge(plan), operation.result);
      assert.equal(fixture.owner.retireCalls, 0); assert.deepEqual(await transcript(fixture), log);
      assert.deepEqual(accounting(fixture), positions); assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
      if (operation.result.status === 'success') await assertRetired(fixture.owner, plan);
      else assert(fixture.store.entry('quiet'));
    } finally { await fixture.close(); }
  }
});
