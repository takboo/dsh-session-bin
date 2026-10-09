import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import { workspaceDomainState } from '@deepseek-ai/dsh-workspace';
import * as product from '../dist/index.js';
import { planSchema } from '../dist/operations.js';
import { createScratch, openFixture, transcript, accounting } from './helpers/fixture.mjs';
import { latch, override, openRetirementFixture } from './helpers/retirement-owner.mjs';

const archive = (fixture, id = 'quiet') => fixture.ctx.workspaceRegistry.archiveSession(SessionId(id));
const unarchive = (fixture, id = 'quiet') => fixture.ctx.workspaceRegistry.unarchiveSession(SessionId(id));
async function openArchive(fixture, { storeWrapper = value => value, nativeWrapper = value => value, options = {}, reconcile = true } = {}) {
  const release = await product.acquireBinLease(join(fixture.root, 'coordination'));
  const domain = await fixture.ctx.storageDomain.open(product.archiveDomainSpec);
  const store = new product.DomainArchiveStore(domain);
  const native = new product.DshBinPort(fixture.ctx);
  const module = new product.ArchiveModule(storeWrapper(store), nativeWrapper(native), options);
  const off = fixture.ctx.root.on('domain/changed', change => {
    if (change.domain === 'workspace' && change.table === '' && change.operation === 'put') {
      void module.observeArchives(change.value.archivedSessionIds).catch(() => {});
    }
  });
  if (reconcile) await module.reconcile();
  let closing;
  return { module, store, native, close: () => closing ??= (async () => {
    try { await module.close(); }
    finally { off(); await domain.close(); await release(); }
  })() };
}

function legacyPlan(sessionId, action = 'bin', operationId = randomUUID()) {
  return planSchema.parse({ schemaVersion: 1, operationId, action, sessionId,
    expected: { archived: false, entryId: null }, blockers: [] });
}

test('production lists all native archive members with persistent observation identities and no invented archive metadata', async t => {
  const root = await createScratch('archive-native-members-'); t.diagnostic(root);
  let fixture = await openFixture(root, { seed: true, legacy: false });
  const before = await transcript(fixture); const positions = accounting(fixture);
  let entries;
  try {
    await archive(fixture, 'native-only'); await archive(fixture, 'ungrouped');
    entries = await fixture.bin.list();
    assert.deepEqual(entries.map(entry => entry.sessionId).sort(), ['native-only', 'ungrouped']);
    for (const entry of entries) assert.deepEqual(Object.keys(entry).sort(), ['entryId', 'schemaVersion', 'sessionId']);
    assert.equal([...fixture.ctx.storageDomain.get('session_bin').table('entries').entries()].length, 0);
    assert.equal([...fixture.ctx.storageDomain.get('session_bin_purge').table('bindings').entries()].length, 0);
    await fixture.close(); fixture = await openFixture(root, { legacy: false });
    assert.deepEqual(await fixture.bin.list(), entries);
    assert.deepEqual(await transcript(fixture), before); assert.deepEqual(accounting(fixture), positions);
    const plan = await fixture.bin.prepare({ action: 'unarchive', sessionId: 'native-only' });
    const result = await fixture.bin.execute(plan); assert.equal(result.status, 'success');
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('native-only'));
    await archive(fixture, 'native-only');
    const newEntry = (await fixture.bin.list()).find(entry => entry.sessionId === 'native-only');
    assert.notEqual(newEntry.entryId, entries.find(entry => entry.sessionId === 'native-only').entryId);
    assert.deepEqual(await fixture.bin.execute(plan), result);
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('native-only'), 'historical unarchive cannot affect a later identity');
  } finally { await fixture.close(); }
});

test('production preserves legacy receipts, disables unknown v1 mutations, and unarchives legacy wasArchived targets through native', async t => {
  const root = await createScratch('archive-legacy-history-'); t.diagnostic(root);
  let fixture = await openFixture(root, { seed: true });
  await archive(fixture);
  const oldPlan = await fixture.bin.prepare({ action: 'bin', sessionId: 'quiet' });
  const historical = await fixture.bin.execute(oldPlan); assert.equal(historical.status, 'success');
  await fixture.close(); fixture = await openFixture(root, { legacy: false });
  try {
    assert.deepEqual(await fixture.bin.execute(oldPlan), historical);
    assert.equal((await fixture.bin.getOperation(oldPlan.operationId)).schemaVersion, 1);
    const unknown = legacyPlan('sibling');
    const rejected = await fixture.bin.execute(unknown);
    assert.equal(rejected.status, 'rejected'); assert.equal(rejected.reason, 'legacy-operation-disabled');
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('sibling'));
    const plan = await fixture.bin.prepare({ action: 'unarchive', sessionId: 'quiet' });
    assert.equal((await fixture.bin.execute(plan)).status, 'success');
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'), 'wasArchived must not preserve native archive in v2');
    await assert.rejects(fixture.bin.prepare({ action: 'unarchive', sessionId: 'sibling', operationId: oldPlan.operationId }),
      error => error.code === 'bin/operation-id-reused');
    await assert.rejects(fixture.bin.execute(legacyPlan('sibling', 'bin', plan.operationId)), error => error.code === 'bin/operation-id-reused');
    await assert.rejects(fixture.bin.executePurge({ schemaVersion: 1, action: 'purge', operationId: plan.operationId,
      sessionId: 'quiet', expectedEntryId: null, binding: null, manifest: null, blockers: [] }), error => error.code === 'bin/operation-id-reused');
  } finally { await fixture.close(); }
});

for (const phase of ['intent', 'applied']) test(`startup migration of legacy ${phase} is metadata only and does not create purge witnesses`, async () => {
  const root = await createScratch(`archive-legacy-${phase}-`);
  let fixture = await openFixture(root, { seed: true });
  const plan = await fixture.bin.prepare({ action: 'bin', sessionId: 'quiet' });
  await fixture.bin.execute(plan);
  const domain = fixture.ctx.storageDomain.get('session_bin');
  const store = new product.DomainBinStore(domain);
  await store.putOperation({ ...store.operation(plan.operationId), phase, result: null });
  // Close reconciles the legacy journal; restore the pending record only after
  // closing the test core, through the public storage domain in a fresh context.
  const pending = store.operation(plan.operationId);
  await fixture.close();
  fixture = await openFixture(root, { plugin: false });
  const oldDomain = await fixture.ctx.storageDomain.open(product.binDomainSpec);
  await new product.DomainBinStore(oldDomain).putOperation(pending); await oldDomain.close();
  let writes = 0;
  const registry = fixture.ctx.workspaceRegistry;
  registry.archiveSession = async () => { writes += 1; throw new Error('startup native mutation forbidden'); };
  registry.unarchiveSession = async () => { writes += 1; throw new Error('startup native mutation forbidden'); };
  try {
    await fixture.mount(product, { coordinationDirectory: join(root, 'coordination') });
    const service = fixture.ctx.get('sessionBin');
    assert.equal((await service.list()).length, 1);
    const receipt = await service.getOperation(plan.operationId);
    assert.equal(receipt.phase, 'done'); assert.equal(receipt.result.status, phase === 'intent' ? 'conflict' : 'success');
    assert.equal(writes, 0);
    assert.equal([...fixture.ctx.storageDomain.get('session_bin_purge').table('bindings').entries()].length, 0);
  } finally { await fixture.close(); }
});

test('production explicitly disabled purge stays unsupported and observation never acquires a lifecycle witness', async () => {
  const fixture = await openFixture(await createScratch('archive-purge-disabled-'), { seed: true, legacy: false, permanentDeletion: false });
  try {
    await archive(fixture, 'native-only');
    const plan = await fixture.bin.preparePurge({ sessionId: 'native-only' });
    assert.equal(plan.blockers[0].code, 'permanent-deletion-unsupported');
    assert.equal(plan.binding, null); assert.equal(plan.manifest, null);
    const result = await fixture.bin.executePurge(plan);
    assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'permanent-deletion-unsupported');
    assert.equal((await fixture.bin.getPurgeOperation(plan.operationId)).phase, 'done');
    await assert.rejects(fixture.bin.prepare({ action: 'unarchive', sessionId: 'native-only', operationId: plan.operationId }),
      error => error.code === 'bin/operation-id-reused');
    assert.equal([...fixture.ctx.storageDomain.get('session_bin_purge').table('bindings').entries()].length, 0);
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('native-only'));
  } finally { await fixture.close(); }
});

test('persisted legacy pending purge guard blocks production unarchive across startup without advancing owner resources', async t => {
  const root = await createScratch('archive-purge-guard-'); t.diagnostic(root);
  let fixture = await openRetirementFixture(root, { seed: true, ownerOptions: { pauseAt: 'fenced' } });
  const move = await fixture.module.prepare({ action: 'bin', sessionId: 'quiet' });
  await fixture.module.execute(move);
  const purge = await fixture.module.preparePurge({ sessionId: 'quiet' });
  assert.equal((await fixture.module.executePurge(purge)).status, 'pending-recovery');
  const log = await transcript(fixture);
  await fixture.close(); fixture = await openFixture(root, { legacy: false });
  try {
    assert.equal((await fixture.bin.list())[0].sessionId, 'quiet');
    const plan = await fixture.bin.prepare({ action: 'unarchive', sessionId: 'quiet' });
    assert(plan.blockers.some(blocker => blocker.code === 'pending-deletion'));
    const result = await fixture.bin.execute({ ...plan, blockers: [] });
    assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'pending-deletion');
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    assert.notEqual((await fixture.bin.getPurgeOperation(purge.operationId)).phase, 'done');
    assert.deepEqual(await transcript(fixture), log);
    assert(fixture.ctx.storageDomain.get('session_bin').table('entries').get('quiet'));
  } finally { await fixture.close(); }
});

test('observed native unarchive/rearchive replaces entry identity immediately even before queued reconciliation', async () => {
  const fixture = await openFixture(await createScratch('archive-observed-aba-'), { seed: true, legacy: false });
  try {
    await archive(fixture);
    const plan = await fixture.bin.prepare({ action: 'unarchive', sessionId: 'quiet' });
    await unarchive(fixture); await archive(fixture);
    const result = await fixture.bin.execute(plan);
    assert.equal(result.status, 'conflict');
    assert.notEqual((await fixture.bin.list())[0].entryId, plan.expected.entryId);
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
  } finally { await fixture.close(); }
});

test('native missing archive members are visible but cannot use idempotent unarchive as existence proof', async () => {
  const fixture = await openFixture(await createScratch('archive-missing-member-'), { seed: true, legacy: false });
  try {
    const domain = fixture.ctx.storageDomain.get('workspace');
    const state = workspaceDomainState.parse(domain.global.get());
    await domain.global.set({ ...state, archivedSessionIds: ['missing-session'] });
    assert.equal((await fixture.bin.list())[0].sessionId, 'missing-session');
    const plan = await fixture.bin.prepare({ action: 'unarchive', sessionId: 'missing-session' });
    assert(plan.blockers.some(item => item.code === 'session-not-found'));
    const result = await fixture.bin.execute(plan); assert.equal(result.reason, 'session-not-found');
    assert(workspaceDomainState.parse(domain.global.get()).archivedSessionIds.includes('missing-session'));
  } finally { await fixture.close(); }
});

for (const change of ['archive-another', 'unarchive-current', 'observed-aba']) test(`slow sidecar put converges the complete native set after ${change}`, { timeout: 15000 }, async () => {
  const fixture = await openFixture(await createScratch('archive-put-race-'), { seed: true, plugin: false });
  const gate = latch(); let paused = false;
  const opened = await openArchive(fixture, { storeWrapper: store => override(store, {
    async putEntry(entry) { if (!paused) { paused = true; await gate.pause(); } await store.putEntry(entry); },
  }) });
  try {
    const start = archive(fixture); await start; await gate.entered;
    if (change === 'archive-another') await archive(fixture, 'sibling');
    else { await unarchive(fixture); if (change === 'observed-aba') await archive(fixture); }
    gate.release();
    const listed = await opened.module.list();
    assert.deepEqual(listed.map(entry => entry.sessionId).sort(), [...fixture.ctx.workspaceRegistry.archivedSessionIds].sort());
    assert.deepEqual(opened.store.entries(), listed);
  } finally { gate.release(); await opened.close(); await fixture.close(); }
});

for (const change of ['identity', 'purge-guard', 'known']) test(`execution rechecks ${change} after intent persistence before native unarchive`, { timeout: 15000 }, async () => {
  const fixture = await openFixture(await createScratch('archive-intent-recheck-'), { seed: true, plugin: false });
  await archive(fixture);
  const gate = latch(); let mutations = 0; let pending = false; let known = true;
  const opened = await openArchive(fixture, {
    options: { pendingPurge: () => pending },
    storeWrapper: store => override(store, { async putOperation(operation) {
      await store.putOperation(operation); if (operation.phase === 'intent') await gate.pause();
    } }),
    nativeWrapper: native => override(native, {
      async inspect(id) { return { ...await native.inspect(id), known }; },
      async unarchive(id) { mutations += 1; await native.unarchive(id); },
    }),
  });
  try {
    const plan = await opened.module.prepare({ action: 'unarchive', sessionId: 'quiet' });
    const result = opened.module.execute(plan); await gate.entered;
    if (change === 'identity') { await unarchive(fixture); await archive(fixture); }
    else if (change === 'purge-guard') pending = true;
    else known = false;
    gate.release();
    const receipt = await result;
    assert.equal(receipt.status, change === 'identity' ? 'conflict' : 'rejected');
    assert.equal(receipt.reason, change === 'purge-guard' ? 'pending-deletion' : change === 'known' ? 'session-not-found' : 'state-changed');
    assert.equal(mutations, 0); assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
  } finally { gate.release(); await opened.close(); await fixture.close(); }
});

for (const boundary of ['native-ack', 'applied-ack']) test(`unknown ${boundary} failure suspends requests and reopening only reconciles metadata`, async () => {
  const root = await createScratch(`archive-failure-${boundary}-`);
  let fixture = await openFixture(root, { seed: true, plugin: false }); await archive(fixture);
  let mutations = 0;
  let opened = await openArchive(fixture, {
    nativeWrapper: native => override(native, { async unarchive(id) {
      mutations += 1; await native.unarchive(id); if (boundary === 'native-ack') throw new Error('native acknowledgement lost');
    } }),
    storeWrapper: store => override(store, { async putOperation(operation) {
      await store.putOperation(operation); if (boundary === 'applied-ack' && operation.phase === 'applied') throw new Error('applied acknowledgement lost');
    } }),
  });
  const plan = await opened.module.prepare({ action: 'unarchive', sessionId: 'quiet' });
  try {
    await assert.rejects(opened.module.execute(plan), /acknowledgement lost/);
    await assert.rejects(opened.module.list(), error => error.code === 'bin/recovery-required');
    await opened.close(); await fixture.close();
    fixture = await openFixture(root, { plugin: false });
    opened = await openArchive(fixture, { nativeWrapper: native => override(native, { async unarchive() { mutations += 1; } }) });
    const receipt = await opened.module.execute(plan);
    assert.equal(receipt.status, boundary === 'native-ack' ? 'conflict' : 'success');
    assert.equal(mutations, 1); assert.deepEqual(await opened.module.list(), []);
  } finally { await opened.close(); await fixture.close(); }
});

for (const mode of ['failure', 'cancel']) test(`third archive domain open ${mode} closes both legacy domains and releases the drained lease`, { timeout: 15000 }, async () => {
  const fixture = await openFixture(await createScratch(`archive-third-open-${mode}-`), { seed: true, plugin: false });
  const backend = fixture.ctx.storage.backend.get('json');
  const original = backend.kv.open.bind(backend.kv);
  const gate = latch();
  let fiber; let disposing;
  backend.kv.open = async descriptor => {
    if (descriptor.name === product.archiveDomainSpec.name && mode === 'failure') throw new Error('third archive open failed');
    const unit = await original(descriptor);
    if (descriptor.name === product.archiveDomainSpec.name) await gate.pause();
    return unit;
  };
  const contains = (error, text) => Boolean(error && (String(error.message).includes(text)
    || contains(error.cause, text) || error.errors?.some(item => contains(item, text))));
  try {
    fiber = fixture.ctx.plugin(product.SessionBin, { coordinationDirectory: join(fixture.root, 'coordination') });
    const startup = fiber.await().then(() => ({ error: null }), error => ({ error }));
    if (mode === 'cancel') {
      await gate.entered;
      disposing = fiber.dispose();
      await assert.rejects(product.acquireBinLease(join(fixture.root, 'coordination')), error => error.code === 'bin/lease-unavailable');
      gate.release();
      assert.equal((await startup).error?.code, 'INACTIVE_EFFECT');
      await disposing;
    } else {
      assert(contains((await startup).error, 'third archive open failed'));
      await fiber.dispose();
    }
    for (const name of ['session_bin', 'session_bin_purge', 'session_archive']) assert.equal(fixture.ctx.storageDomain.get(name), undefined);
    assert.equal(fixture.ctx.get('sessionBin'), undefined);
    const release = await product.acquireBinLease(join(fixture.root, 'coordination')); await release();
  } finally {
    gate.release(); backend.kv.open = original;
    await disposing; await fiber?.dispose(); await fixture.close();
  }
});

const unknownFailures = [
  ['business-class', () => new product.SessionBinError('bin/operation-id-reused', 'external commit acknowledgement lost')],
  ['undefined', () => undefined], ['null', () => null], ['false', () => false], ['zero', () => 0],
];
for (const core of ['archive', 'legacy']) for (const [name, failure] of unknownFailures) {
  test(`${core} core treats external ${name} rejection after intent commit as unknown and only reconciles on reopen`, async () => {
    const root = await createScratch(`archive-unknown-${core}-${name}-`);
    let fixture = await openFixture(root, { seed: true, plugin: false });
    if (core === 'archive') await archive(fixture);
    const thrown = failure(); let mutations = 0;
    const nativeWrapper = native => override(native, {
      async archive(id) { mutations += 1; await native.archive(id); },
      async unarchive(id) { mutations += 1; await native.unarchive(id); },
    });
    const storeWrapper = store => override(store, { async putOperation(operation) {
      await store.putOperation(operation); if (operation.phase === 'intent') throw thrown;
    } });
    let opened = core === 'archive' ? await openArchive(fixture, { nativeWrapper, storeWrapper })
      : await fixture.openModule({ nativeWrapper, storeWrapper });
    const plan = await opened.module.prepare({ action: core === 'archive' ? 'unarchive' : 'bin', sessionId: 'quiet' });
    try {
      await assert.rejects(opened.module.execute(plan), error => error === thrown);
      await assert.rejects(opened.module.list(), error => error.code === 'bin/recovery-required');
      await assert.rejects(opened.module.observeArchives(fixture.ctx.workspaceRegistry.archivedSessionIds), error => error.code === 'bin/recovery-required');
      assert.equal(mutations, 0);
      await opened.close(); await fixture.close();
      fixture = await openFixture(root, { plugin: false });
      opened = core === 'archive' ? await openArchive(fixture, { nativeWrapper }) : await fixture.openModule({ nativeWrapper });
      const receipt = await opened.module.execute(plan);
      assert.equal(receipt.status, 'conflict'); assert.equal(receipt.reason, 'interrupted');
      assert.equal(mutations, 0);
    } finally { await opened.close(); await fixture.close(); }
  });
}

for (const [name, failure] of [unknownFailures[0], unknownFailures[3]]) {
  test(`production legacy observation ${name} failure pauses Archive instead of trusting stale legacy memory`, { timeout: 15000 }, async () => {
    const root = await createScratch(`archive-observer-failure-${name}-`);
    let fixture = await openFixture(root, { seed: true });
    await fixture.bin.execute(await fixture.bin.prepare({ action: 'bin', sessionId: 'quiet' }));
    await fixture.close(); fixture = await openFixture(root, { plugin: false });
    const facet = fixture.ctx.storage.backend.get('json').kv;
    const originalOpen = facet.open;
    const committed = Promise.withResolvers(); let injected = false;
    facet.open = async function (descriptor) {
      const unit = await originalOpen.call(facet, descriptor);
      if (descriptor.name !== product.binDomainSpec.name) return unit;
      return override(unit, { async putRecord(table, key, value) {
        await unit.putRecord(table, key, value);
        if (!injected && table === 'operations' && value.ownershipInvalidated) {
          injected = true; committed.resolve(); throw failure();
        }
      } });
    };
    try {
      await fixture.mount(product, { coordinationDirectory: join(root, 'coordination') });
      const service = fixture.ctx.get('sessionBin');
      await service.list();
      await unarchive(fixture); await archive(fixture); await committed.promise;
      await assert.rejects(service.list(), error => error.code === 'bin/recovery-required');
      await assert.rejects(service.prepare({ action: 'unarchive', sessionId: 'quiet' }), error => error.code === 'bin/recovery-required');
      assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
      facet.open = originalOpen;
      await fixture.close(); fixture = await openFixture(root, { legacy: false });
      assert.equal((await fixture.bin.list()).length, 1);
      assert.equal([...fixture.ctx.storageDomain.get('session_bin').table('entries').entries()].length, 0);
      assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    } finally { facet.open = originalOpen; await fixture.close(); }
  });
}

for (const method of ['entries', 'operations']) test(`legacy immediate frame capture suspends after external ${method} read failure`, async () => {
  const fixture = await openFixture(await createScratch(`archive-frame-read-${method}-`), { seed: true, plugin: false });
  let injected = false;
  const failure = method === 'entries' ? new product.SessionBinError('bin/operation-id-reused', 'external synchronous read failed') : false;
  const opened = await fixture.openModule({ storeWrapper: store => override(store, {
    [method]() { if (injected) throw failure; return store[method](); },
  }) });
  try {
    injected = true;
    await assert.rejects(opened.module.observeArchives([]), error => error === failure);
    await assert.rejects(opened.module.prepare({ action: 'bin', sessionId: 'quiet' }), error => error.code === 'bin/recovery-required');
    assert.deepEqual(fixture.ctx.workspaceRegistry.archivedSessionIds, []);
  } finally { await opened.close(); await fixture.close(); }
});
