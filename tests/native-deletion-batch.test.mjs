import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SessionBinClientModel, retirementManifestDigest } from '../dist/client-model.js';
import { within } from './helpers/remote-fixture.mjs';

const clone = value => structuredClone(value);
const ok = value => ({ ok: true, value });
const nonce = '76a1e295-eb03-4b20-9429-040b85b416a0';
const makeEntry = sessionId => ({ schemaVersion: 2, sessionId, entryId: randomUUID() });

function planFor(target, operationId = randomUUID(), resources) {
  const lifecycle = { storeId: 'batch-test-store', sessionId: target.sessionId, lifecycleId: `life-${target.entryId}` };
  const capabilities = { protocolVersion: 1, ownerId: 'batch-test-owner', hostVersion: 'test', providerId: 'test', storeId: lifecycle.storeId,
    participants: [{ id: 'batch-test-resources', version: '1' }] };
  return { schemaVersion: 2, action: 'purge', operationId, sessionId: target.sessionId, expectedEntryId: target.entryId,
    binding: { schemaVersion: 2, target: 'native-archive', entryId: target.entryId, entryVersion: 2, lifecycle, capabilities },
    manifest: { schemaVersion: 1, lifecycle, capabilities, resources: resources ?? [{ ownerId: 'batch-test-resources',
      resourceId: `log-${target.sessionId}`, revision: '1', kind: 'transcript', disposition: 'erase', retention: null }] }, blockers: [] };
}

function resultFor(plan, status = 'success') {
  if (status === 'rejected' || status === 'conflict') return { action: 'purge', operationId: plan.operationId,
    sessionId: plan.sessionId, entryId: plan.expectedEntryId, status, reason: `batch-${status}`, ownerState: null };
  const phase = status === 'success' ? 'done' : status === 'partial-failure' ? 'erasing' : 'fenced';
  const resources = status === 'success' ? plan.manifest.resources.map(resource => ({ ownerId: resource.ownerId,
    resourceId: resource.resourceId, status: resource.disposition === 'erase' ? 'erased'
      : resource.disposition === 'release-reference' ? 'reference-released' : 'retained',
    reason: resource.disposition === 'retain-shared' ? 'shared-reference'
      : resource.disposition === 'retain-coordination' ? 'coordination-identity' : null }))
    : status === 'partial-failure' ? [{ ownerId: plan.manifest.resources[0].ownerId,
      resourceId: plan.manifest.resources[0].resourceId, status: 'failed', reason: 'batch-failure' }] : [];
  const ownerState = { schemaVersion: 1, request: { operationId: plan.operationId, expected: clone(plan.binding.lifecycle),
    bin: { kind: 'native-archive', entryId: plan.expectedEntryId, entryVersion: 2 }, manifestDigest: retirementManifestDigest(plan.manifest) },
  manifest: clone(plan.manifest), authorizationId: nonce, phase, reason: null, resources };
  return { action: 'purge', operationId: plan.operationId, sessionId: plan.sessionId, entryId: plan.expectedEntryId,
    status, reason: status === 'success' ? null : status === 'partial-failure' ? 'resource-failure' : 'owner-incomplete', ownerState };
}

function operationFor(plan, result) {
  return { schemaVersion: 2, plan: clone(plan), createdAt: '2026-10-07T10:00:00.000Z',
    phase: ['success', 'rejected', 'conflict'].includes(result.status) ? 'done' : 'owner-pending',
    entry: { schemaVersion: 2, sessionId: plan.sessionId, entryId: plan.expectedEntryId },
    authorizationId: result.ownerState?.authorizationId ?? null, ownerState: clone(result.ownerState), result: clone(result) };
}

function savedCache() {
  let plans = []; let grants = []; let observations = []; let batchOperations = []; let peak = 0;
  return { load: () => [], save() {}, loadPurge: () => clone(plans), savePurge: (next, nextBatchOperations = []) => {
    plans = clone(next); peak = Math.max(peak, plans.length); const active = new Set(plans.map(plan => plan.operationId));
    grants = grants.filter(row => active.has(row.operationId)); observations = observations.filter(row => active.has(row.operationId));
    batchOperations = clone(nextBatchOperations).filter(operationId => active.has(operationId));
  }, loadPurgeGrants: () => clone(grants), savePurgeGrants: next => { grants = clone(next); },
  loadPurgeGrantObservations: () => clone(observations), stagePurgeGrantObservation: operationId => {
    if (!observations.some(row => row.operationId === operationId)) observations.push({ operationId });
  }, loadPurgeBatchOperations: () => clone(batchOperations), peak: () => peak };
}

function streamFactory(state) {
  return () => {
    const stop = Promise.withResolvers(); const abort = new AbortController();
    return { dispose: async () => { abort.abort(); stop.resolve(); }, async *[Symbol.asyncIterator]() {
      yield { value: { schemaVersion: 2, entries: clone(state.entries) }, signal: abort.signal, accept() {} };
      await Promise.race([stop.promise, state.disconnect?.promise ?? stop.promise]);
      if (!abort.signal.aborted && state.disconnect) throw new Error('follow disconnected');
    } };
  };
}

async function waitFor(model, predicate, signal) {
  if (predicate(model.getSnapshot())) return;
  const ready = Promise.withResolvers();
  const off = model.subscribe(() => { if (predicate(model.getSnapshot())) ready.resolve(); });
  try { await within(ready.promise, signal); } finally { off(); }
}
async function ready(model, signal) { await model.refresh(); await waitFor(model, state => state.phase === 'ready', signal); }

function controlled(entries) {
  const state = { entries: clone(entries), prepares: [], executes: [], operations: new Map(), modes: new Map(), unknownOperations: new Set(),
    blockers: new Map(), resources: new Map(), executeGate: null, activeExecutions: 0, maxExecutions: 0 };
  const cache = savedCache();
  const api = {
    async preparePurge(request) {
      state.prepares.push(clone(request));
      const target = state.entries.find(row => row.sessionId === request.sessionId);
      const plan = planFor(target, request.operationId, state.resources.get(request.sessionId));
      plan.blockers = clone(state.blockers.get(request.sessionId) ?? []); return ok(plan);
    },
    async executePurge(plan) {
      state.executes.push(clone(plan)); state.activeExecutions += 1;
      state.maxExecutions = Math.max(state.maxExecutions, state.activeExecutions);
      try {
        if (state.executeGate) await state.executeGate.promise;
        const mode = state.modes.get(plan.sessionId) ?? 'success';
        if (mode === 'missing') throw new Error('request did not reach Host');
        if (mode === 'transport-unknown') { state.unknownOperations.add(plan.operationId); throw new Error('transport outcome unknown'); }
        const result = resultFor(plan, mode); state.operations.set(plan.operationId, operationFor(plan, result)); return ok(clone(result));
      } finally { state.activeExecutions -= 1; }
    },
    async getPurgeOperation(operationId) {
      if (state.unknownOperations.has(operationId)) throw new Error('transport unavailable');
      return ok(clone(state.operations.get(operationId) ?? null));
    },
    async purgeOperations() { return ok([...state.operations.values()].map(clone)); },
    async getOperation() { return ok(null); },
    async prepare() { throw new Error('unexpected unarchive'); },
  };
  return { state, cache, api, stream: streamFactory(state), model: () => new SessionBinClientModel(api, streamFactory(state), cache) };
}

function scopeOf(...entries) { return { kind: 'selection', entryIds: entries.map(entry => entry.entryId) }; }

test('batch freezes A/B, excludes later C and replacement observations, and isolates public plan snapshots', { timeout: 15000 }, async t => {
  const a = makeEntry('A'); const b = makeEntry('B'); const h = controlled([a, b]); const model = h.model();
  const firstPrepare = Promise.withResolvers(); const release = Promise.withResolvers(); const originalPrepare = h.api.preparePurge;
  h.api.preparePurge = async request => { if (request.sessionId === 'A') { firstPrepare.resolve(); await release.promise; } return originalPrepare(request); };
  try {
    await ready(model, t.signal); const preparing = model.preparePurgeBatch(scopeOf(a, b), { A: 'Title A', B: 'Title B' });
    await within(firstPrepare.promise, t.signal); const replacement = makeEntry('B'); const c = makeEntry('C');
    h.state.entries = [a, replacement, c]; await ready(model, t.signal); release.resolve(); const batch = await preparing;
    assert.deepEqual(h.state.prepares.map(row => row.sessionId), ['A', 'B']);
    assert.equal(batch.frozenCount, 2); assert.deepEqual(batch.items.map(item => item.target.entryId), [a.entryId, b.entryId]);
    assert.equal(batch.items[1].state, 'blocked'); assert.equal(batch.items[1].reason, 'entry-changed');
    batch.items[0].plan.expectedEntryId = c.entryId; batch.items.push(clone(batch.items[0]));
    model.getSnapshot().purgeBatch.items[0].plan.sessionId = 'C';
    model.acknowledgePurgeBatch(true); await model.runPurgeBatch();
    assert.equal(h.state.executes.length, 1); assert.equal(h.state.executes[0].sessionId, 'A');
    assert.equal(h.state.executes[0].expectedEntryId, a.entryId); assert.equal(model.getSnapshot().purgeBatch.frozenCount, 2);
  } finally { release.resolve(); await model.dispose(); }
});

test('stopping preparation drains its accepted request before a later batch can be admitted', { timeout: 15000 }, async t => {
  const a = makeEntry('A'); const b = makeEntry('B'); const h = controlled([a, b]); const model = h.model();
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const prepare = h.api.preparePurge;
  h.api.preparePurge = async request => { if (request.sessionId === 'A') { entered.resolve(); await release.promise; } return prepare(request); };
  let pending;
  try {
    await ready(model, t.signal); pending = model.preparePurgeBatch(scopeOf(a, b));
    await within(entered.promise, t.signal);
    const oldBatchId = model.getSnapshot().purgeBatch.batchId;
    model.stopPurgeBatch(); model.dismissPurgeBatch();
    assert.equal(await model.preparePurgeBatch(scopeOf(b)), null);
    assert.equal(await model.preparePurge(b, 'B'), null);
    assert.equal(model.getSnapshot().purgeBatch.batchId, oldBatchId);
    release.resolve(); const cancelled = await pending;
    assert.equal(cancelled.phase, 'cancelled'); assert.equal(h.state.prepares.length, 1);
    assert.equal(h.state.executes.length, 0);
    model.dismissPurgeBatch(); const next = await model.preparePurgeBatch(scopeOf(b));
    assert.notEqual(next.batchId, oldBatchId); assert.equal(next.phase, 'confirming');
    assert.deepEqual(next.items.map(item => item.target.sessionId), ['B']);
  } finally { release.resolve(); await pending; await model.dispose(); }
});

test('all-archived freezes the complete model collection and reports blockers plus independent resource counts', { timeout: 15000 }, async t => {
  const entries = Array.from({ length: 10 }, (_, index) => makeEntry(`S${index}`)); const h = controlled(entries); const model = h.model();
  const target = entries[3]; const lifecycle = { storeId: 'batch-test-store', sessionId: target.sessionId, lifecycleId: `life-${target.entryId}` };
  h.state.resources.set(target.sessionId, [
    { ownerId: 'batch-test-resources', resourceId: 'log', revision: '1', kind: 'transcript', disposition: 'erase', retention: null },
    { ownerId: 'batch-test-resources', resourceId: 'ref', revision: '1', kind: 'attachment', disposition: 'release-reference', retention: null },
    { ownerId: 'batch-test-resources', resourceId: 'shared', revision: '1', kind: 'attachment', disposition: 'retain-shared',
      retention: { reason: 'shared-reference', retainedBy: [{ ...lifecycle, sessionId: 'survivor', lifecycleId: 'other-life' }] } },
    { ownerId: 'batch-test-resources', resourceId: 'lock', revision: '1', kind: 'coordination', disposition: 'retain-coordination',
      retention: { reason: 'coordination-identity', retainedBy: [] } },
  ]);
  h.state.blockers.set('S7', [{ code: 'jsonl/writer-active' }]);
  try {
    await ready(model, t.signal); const visibleRows = entries.slice(0, 2); assert.equal(visibleRows.length, 2);
    const batch = await model.preparePurgeBatch({ kind: 'all-archived' }, Object.fromEntries(entries.map(row => [row.sessionId, `Title ${row.sessionId}`])));
    assert.equal(batch.frozenCount, 10); assert.equal(h.state.prepares.length, 10); assert.equal(batch.items[7].state, 'blocked');
    assert.equal(batch.items[7].reason, 'jsonl/writer-active'); assert.equal(batch.items[7].outcome, null);
    assert.deepEqual(batch.resourceCounts, { erase: 10, releaseReference: 1, retainShared: 1, retainCoordination: 1 });
    assert.notEqual(batch.items[0].plan.operationId, batch.items[1].plan.operationId);
    assert.notDeepEqual(batch.items[3].plan.manifest.resources, batch.items[0].plan.manifest.resources);
  } finally { await model.dispose(); }
});

test('batch execution is strictly serial and continues across success, rejection, and conflict', { timeout: 15000 }, async t => {
  const entries = ['success', 'rejected', 'conflict', 'last'].map(makeEntry); const h = controlled(entries); const model = h.model();
  h.state.modes.set('rejected', 'rejected'); h.state.modes.set('conflict', 'conflict');
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(...entries)); model.acknowledgePurgeBatch(true);
    const batch = await model.runPurgeBatch(); assert.equal(batch.phase, 'done'); assert.equal(h.state.maxExecutions, 1);
    assert.deepEqual(h.state.executes.map(plan => plan.sessionId), entries.map(row => row.sessionId));
    assert.deepEqual(batch.items.map(item => item.outcome.status), ['success', 'rejected', 'conflict', 'success']);
    assert.equal(h.cache.peak(), 1);
  } finally { await model.dispose(); }
});

for (const mode of ['pending-recovery', 'partial-failure', 'transport-unknown', 'missing']) {
  test(`${mode} pauses the batch and later items wait for explicit resolution of the same child`, { timeout: 15000 }, async t => {
    const first = makeEntry('first'); const second = makeEntry('second'); const h = controlled([first, second]); const model = h.model();
    h.state.modes.set('first', mode);
    try {
      await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first, second)); model.acknowledgePurgeBatch(true);
      let batch = await model.runPurgeBatch(); assert.equal(batch.phase, 'paused'); assert.equal(h.state.executes.length, 1);
      await model.runPurgeBatch(); assert.equal(h.state.executes.length, 1, 'batch does not resend or advance while its child is unresolved');
      const oldOperationId = batch.items[0].plan.operationId; h.state.modes.set('first', 'success');
      if (mode === 'missing') {
        const replacement = await model.preparePurgeAgain(oldOperationId, 'First again');
        assert(replacement); assert.notEqual(replacement.operationId, oldOperationId); model.acknowledgePurge(true);
        assert.equal((await model.confirmPurge()).status, 'success');
      } else if (mode === 'transport-unknown') {
        const plan = batch.items[0].plan; const result = resultFor(plan, 'success');
        h.state.unknownOperations.delete(oldOperationId); h.state.operations.set(oldOperationId, operationFor(plan, result));
        await model.checkPurgePending(); assert.equal(model.getSnapshot().purgePending.length, 0);
      } else assert.equal((await model.retryPurge(oldOperationId)).status, 'success');
      batch = await model.runPurgeBatch(); assert.equal(batch.phase, 'done');
      assert.equal(h.state.executes.at(-1).sessionId, 'second'); assert.equal(h.cache.peak(), 1);
    } finally { await model.dispose(); }
  });
}

test('stop during an in-flight execute does not abort it and cancels every unsent item', { timeout: 15000 }, async t => {
  const entries = ['A', 'B', 'C'].map(makeEntry); const h = controlled(entries); const model = h.model();
  h.state.executeGate = Promise.withResolvers();
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(...entries)); model.acknowledgePurgeBatch(true);
    const running = model.runPurgeBatch(); await waitFor(model, state => state.purgeBatch.items[0].state === 'running', t.signal);
    const operationId = model.getSnapshot().purgeBatch.items[0].plan.operationId; model.stopPurgeBatch();
    assert.equal(model.getSnapshot().purgePending[0].operationId, operationId); h.state.executeGate.resolve();
    const batch = await running; assert.equal(batch.phase, 'cancelled'); assert.equal(batch.stopRequested, true);
    assert.deepEqual(batch.items.map(item => item.state), ['settled', 'cancelled', 'cancelled']); assert.equal(h.state.executes.length, 1);
  } finally { h.state.executeGate.resolve(); await model.dispose(); }
});

test('late fresh preparation cannot publish after its paused batch is stopped and dismissed', { timeout: 15000 }, async t => {
  const first = makeEntry('first'); const second = makeEntry('second'); const h = controlled([first, second]); const model = h.model();
  h.state.modes.set('first', 'missing');
  const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const prepare = h.api.preparePurge;
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first, second)); model.acknowledgePurgeBatch(true);
    const paused = await model.runPurgeBatch(); const oldOperationId = paused.items[0].plan.operationId;
    h.api.preparePurge = async request => { entered.resolve(); await release.promise; return prepare(request); };
    const fresh = model.preparePurgeAgain(oldOperationId, 'First again'); await within(entered.promise, t.signal);
    model.stopPurgeBatch(); model.dismissPurgeBatch(); release.resolve();
    assert.equal(await fresh, null); assert.equal(model.getSnapshot().purgeConfirmation, null);
    assert.equal(model.getSnapshot().purgePending[0].operationId, oldOperationId);
    assert.equal(h.state.executes.length, 1, 'late preparation never opens an execute entry point');
  } finally { release.resolve(); await model.dispose(); }
});

test('cancelling fresh confirmation preserves the old batch guard and permits another explicit fresh confirmation', { timeout: 15000 }, async t => {
  const first = makeEntry('first'); const second = makeEntry('second'); const h = controlled([first, second]); const model = h.model();
  h.state.modes.set('first', 'missing');
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first, second)); model.acknowledgePurgeBatch(true);
    let batch = await model.runPurgeBatch(); const oldOperationId = batch.items[0].plan.operationId;
    const cancelledFresh = await model.preparePurgeAgain(oldOperationId, 'First again');
    assert(cancelledFresh); assert.equal(model.getSnapshot().purgePending[0].operationId, oldOperationId);
    model.cancelPurge(); assert.equal(model.getSnapshot().purgeConfirmation, null);
    assert.equal(model.getSnapshot().purgePending[0].operationId, oldOperationId);
    assert.equal(model.getSnapshot().purgeResults.find(result => result.operationId === oldOperationId)?.reason,
      'deletion-result-missing');

    const confirmedFresh = await model.preparePurgeAgain(oldOperationId, 'First again');
    assert(confirmedFresh); assert.notEqual(confirmedFresh.operationId, cancelledFresh.operationId);
    h.state.modes.set('first', 'success'); model.acknowledgePurge(true);
    assert.equal((await model.confirmPurge()).status, 'success');
    assert.equal(model.getSnapshot().purgeResults.some(result => result.operationId === oldOperationId), false);
    assert.deepEqual(h.state.executes.map(plan => plan.operationId), [oldOperationId, confirmedFresh.operationId]);
    batch = await model.runPurgeBatch(); assert.equal(batch.phase, 'done');
    assert.deepEqual(h.state.executes.map(plan => plan.sessionId), ['first', 'first', 'second']);
  } finally { await model.dispose(); }
});

test('stopped and dismissed batch provenance survives reload and rejects the missing discard bypass', { timeout: 15000 }, async t => {
  const first = makeEntry('first'); const second = makeEntry('second'); const h = controlled([first, second]); let model = h.model();
  h.state.modes.set('first', 'missing');
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first, second)); model.acknowledgePurgeBatch(true);
    const paused = await model.runPurgeBatch(); const operationId = paused.items[0].plan.operationId;
    assert(await model.preparePurgeAgain(operationId, 'First again'));
    model.acknowledgePurge(true); model.stopPurgeBatch();
    assert.equal(model.getSnapshot().purgeConfirmation, null);
    assert.equal(await model.confirmPurge(), undefined); assert.equal(h.state.executes.length, 1);
    model.dismissPurgeBatch();
    assert(await model.preparePurgeAgain(operationId, 'Cancelled batch child'));
    model.cancelPurge();
    assert.equal(model.getSnapshot().purgeBatch, null); assert(model.getSnapshot().purgeBatchOperationIds.includes(operationId));
    assert.equal(await model.discardMissingPurge(operationId), false);
    await model.dispose(); model = h.model(); await ready(model, t.signal);
    await waitFor(model, snapshot => snapshot.purgeResults.some(result => result.operationId === operationId), t.signal);
    assert(model.getSnapshot().purgeBatchOperationIds.includes(operationId));
    assert.equal(await model.discardMissingPurge(operationId), false); assert.equal(h.state.executes.length, 1);
  } finally { await model.dispose(); }
});

test('reload queries only the sent child and drops the unsent in-memory queue', { timeout: 15000 }, async t => {
  const first = makeEntry('first'); const second = makeEntry('second'); const h = controlled([first, second]); h.state.modes.set('first', 'pending-recovery');
  let model = h.model();
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first, second)); model.acknowledgePurgeBatch(true); await model.runPurgeBatch();
    assert.equal(h.state.executes.length, 1); await model.dispose(); model = h.model(); await ready(model, t.signal);
    await waitFor(model, state => state.purgePending.length === 1, t.signal);
    assert.equal(model.getSnapshot().purgeBatch, null); assert.equal(h.state.executes.length, 1);
    assert.equal(model.getSnapshot().purgePending[0].sessionId, 'first');
  } finally { await model.dispose(); }
});

for (const recovery of ['stopped', 'dismissed', 'reload']) {
  test(`a missing batch child permits fresh confirmation after ${recovery} without restoring unsent work`, { timeout: 15000 }, async t => {
    const first = makeEntry('first'); const second = makeEntry('second'); const h = controlled([first, second]); let model = h.model();
    h.state.modes.set('first', 'missing');
    try {
      await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first, second)); model.acknowledgePurgeBatch(true);
      const paused = await model.runPurgeBatch(); const oldOperationId = paused.items[0].plan.operationId;
      if (recovery === 'reload') { await model.dispose(); model = h.model(); await ready(model, t.signal); await model.checkPurgePending(); }
      else { model.stopPurgeBatch(); if (recovery === 'dismissed') model.dismissPurgeBatch(); }
      assert.equal(await model.discardMissingPurge(oldOperationId), false);
      const cancelled = await model.preparePurgeAgain(oldOperationId, 'First again');
      assert(cancelled); assert.notEqual(cancelled.operationId, oldOperationId);
      assert.equal(model.getSnapshot().purgePending[0].operationId, oldOperationId);
      model.cancelPurge(); assert.equal(h.state.executes.length, 1);
      assert(model.getSnapshot().purgeBatchOperationIds.includes(oldOperationId));
      const fresh = await model.preparePurgeAgain(oldOperationId, 'First again'); assert(fresh);
      assert.equal(await model.confirmPurge(), undefined, 'fresh scope still requires acknowledgement');
      h.state.modes.set('first', 'success'); model.acknowledgePurge(true);
      assert.equal((await model.confirmPurge()).status, 'success');
      assert.equal(model.getSnapshot().purgePending.length, 0);
      assert.deepEqual(h.state.executes.map(plan => plan.operationId), [oldOperationId, fresh.operationId]);
      await model.runPurgeBatch(); assert.deepEqual(h.state.executes.map(plan => plan.sessionId), ['first', 'first']);
      if (recovery === 'stopped') {
        assert.equal(model.getSnapshot().purgeBatch.phase, 'cancelled');
        assert.deepEqual(model.getSnapshot().purgeBatch.items.map(item => item.state), ['settled', 'cancelled']);
        assert.equal(model.getSnapshot().purgeBatch.items[0].outcome.status, 'success');
      } else assert.equal(model.getSnapshot().purgeBatch, null);
      assert(await model.preparePurge(second, 'Second'), 'settling the child releases new deletion admission');
      model.cancelPurge();
    } finally { await model.dispose(); }
  });
}

for (const guard of ['observed-grant', 'uncertain-grant', 'replacement-entry']) {
  test(`detached batch recovery preserves the ${guard} guard`, { timeout: 15000 }, async t => {
    const first = makeEntry('first'); const second = makeEntry('second'); const h = controlled([first, second]); let model = h.model();
    h.state.modes.set('first', guard === 'observed-grant' ? 'pending-recovery' : 'missing');
    try {
      await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first, second)); model.acknowledgePurgeBatch(true);
      const paused = await model.runPurgeBatch(); const operationId = paused.items[0].plan.operationId;
      h.state.operations.clear();
      if (guard === 'uncertain-grant') h.cache.stagePurgeGrantObservation(operationId);
      if (guard === 'replacement-entry') h.state.entries = [makeEntry('first'), second];
      await model.dispose(); model = h.model(); await ready(model, t.signal); await model.checkPurgePending();
      const before = h.state.prepares.length;
      assert.equal(await model.preparePurgeAgain(operationId, 'First again'), null);
      assert.equal(h.state.prepares.length, before);
      assert.equal(await model.discardMissingPurge(operationId), false);
      assert.equal(model.getSnapshot().purgePending[0].operationId, operationId);
      assert.equal(h.state.executes.length, 1);
    } finally { await model.dispose(); }
  });
}

for (const terminal of ['success', 'rejected', 'conflict']) {
  test(`follow failure drains the sent ${terminal} item and pauses unsent work until a baseline and explicit continuation`, { timeout: 15000 }, async t => {
    const first = makeEntry('first'); const second = makeEntry('second'); const h = controlled([first, second]);
    h.state.disconnect = Promise.withResolvers(); h.state.executeGate = Promise.withResolvers(); h.state.modes.set('first', terminal);
    const model = h.model();
    try {
      await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first, second)); model.acknowledgePurgeBatch(true);
      const running = model.runPurgeBatch(); await waitFor(model, state => state.purgeBatch.items[0].state === 'running', t.signal);
      h.state.disconnect.resolve(); await waitFor(model, state => state.phase === 'error', t.signal);
      h.state.executeGate.resolve(); const paused = await running;
      assert.equal(paused.phase, 'paused'); assert.equal(paused.items[0].outcome.status, terminal);
      assert.equal(paused.items[1].state, 'ready'); assert.equal(h.state.executes.length, 1);
      await model.runPurgeBatch(); assert.equal(h.state.executes.length, 1, 'offline continuation cannot send another item');
      h.state.disconnect = null; await ready(model, t.signal);
      assert.equal(h.state.executes.length, 1, 'a fresh baseline does not resume scheduling');
      const done = await model.runPurgeBatch(); assert.equal(done.phase, 'done');
      assert.deepEqual(h.state.executes.map(plan => plan.sessionId), ['first', 'second']); assert.equal(h.state.maxExecutions, 1);
    } finally { h.state.executeGate.resolve(); await model.dispose(); }
  });
}

test('a replacement baseline arriving before the sent reply still requires explicit continuation', { timeout: 15000 }, async t => {
  const first = makeEntry('first'); const second = makeEntry('second'); const h = controlled([first, second]);
  h.state.disconnect = Promise.withResolvers(); h.state.executeGate = Promise.withResolvers(); const model = h.model();
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first, second)); model.acknowledgePurgeBatch(true);
    const running = model.runPurgeBatch(); await waitFor(model, state => state.purgeBatch.items[0].state === 'running', t.signal);
    h.state.disconnect.resolve(); await waitFor(model, state => state.phase === 'error', t.signal);
    h.state.disconnect = null; await ready(model, t.signal);
    h.state.executeGate.resolve(); const paused = await running;
    assert.equal(model.getSnapshot().phase, 'ready'); assert.equal(paused.phase, 'paused');
    assert.equal(h.state.executes.length, 1); assert.equal(paused.items[1].state, 'ready');
    assert.equal((await model.runPurgeBatch()).phase, 'done'); assert.equal(h.state.executes.length, 2);
  } finally { h.state.executeGate.resolve(); await model.dispose(); }
});

test('an acknowledged batch cannot start while its follow baseline is disconnected', { timeout: 15000 }, async t => {
  const first = makeEntry('first'); const h = controlled([first]); h.state.disconnect = Promise.withResolvers(); const model = h.model();
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first)); model.acknowledgePurgeBatch(true);
    h.state.disconnect.resolve(); await waitFor(model, state => state.phase === 'error', t.signal);
    await model.runPurgeBatch(); assert.equal(h.state.executes.length, 0);
    assert.equal(model.getSnapshot().purgeBatch.phase, 'confirming');
  } finally { await model.dispose(); }
});

test('a subscription-triggered refresh before dispatch pauses the batch without sending its ready item', { timeout: 15000 }, async t => {
  const first = makeEntry('first'); const h = controlled([first]); const model = h.model(); let refresh; let armed = true;
  const off = model.subscribe(() => {
    const state = model.getSnapshot();
    if (armed && state.purgeBatch?.items[0].state === 'running' && state.purgePending.length === 0) {
      armed = false; refresh = model.refresh();
    }
  });
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first)); model.acknowledgePurgeBatch(true);
    const paused = await model.runPurgeBatch(); await refresh;
    assert.equal(h.state.executes.length, 0); assert.equal(paused.phase, 'paused');
    assert.equal(paused.items[0].state, 'ready'); assert.equal(model.getSnapshot().purgePending.length, 0);
    await waitFor(model, state => state.phase === 'ready', t.signal);
    assert.equal((await model.runPurgeBatch()).phase, 'done'); assert.equal(h.state.executes.length, 1);
  } finally { off(); await model.dispose(); }
});

test('a stop and dismissal during fresh-preparation publication cannot reopen its confirmation', { timeout: 15000 }, async t => {
  const first = makeEntry('first'); const second = makeEntry('second'); const h = controlled([first, second]); const model = h.model();
  h.state.modes.set('first', 'missing'); let off = () => {};
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first, second)); model.acknowledgePurgeBatch(true);
    const paused = await model.runPurgeBatch(); const operationId = paused.items[0].plan.operationId; let armed = true;
    off = model.subscribe(() => {
      const state = model.getSnapshot();
      if (armed && state.error === null && state.purgeConfirmation === null && state.purgeBatch?.phase === 'paused') {
        armed = false; model.stopPurgeBatch(); model.dismissPurgeBatch();
      }
    });
    assert.equal(await model.preparePurgeAgain(operationId, 'First again'), null);
    assert.equal(model.getSnapshot().purgeConfirmation, null); assert.equal(model.getSnapshot().purgeBatch, null);
    assert.equal(model.getSnapshot().purgePending[0].operationId, operationId); assert.equal(h.state.executes.length, 1);
  } finally { off(); await model.dispose(); }
});

test('explicit saved-operation continuation rechecks connection after its awaited journal query', { timeout: 15000 }, async t => {
  const first = makeEntry('first'); const h = controlled([first]); h.state.disconnect = Promise.withResolvers();
  h.state.modes.set('first', 'pending-recovery'); const model = h.model();
  const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const read = h.api.getPurgeOperation;
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first)); model.acknowledgePurgeBatch(true);
    const paused = await model.runPurgeBatch(); const operationId = paused.items[0].plan.operationId;
    h.api.getPurgeOperation = async id => { entered.resolve(); await release.promise; return read(id); };
    const retry = model.retryPurge(operationId); await within(entered.promise, t.signal);
    h.state.disconnect.resolve(); await waitFor(model, state => state.phase === 'error', t.signal); release.resolve(); await retry;
    assert.equal(h.state.executes.length, 1); assert.equal(model.getSnapshot().purgePending[0].operationId, operationId);
    h.state.disconnect = null; h.api.getPurgeOperation = read; await ready(model, t.signal);
    h.state.modes.set('first', 'success'); assert.equal((await model.retryPurge(operationId)).status, 'success');
    assert.deepEqual(h.state.executes.map(plan => plan.operationId), [operationId, operationId]);
  } finally { release.resolve(); await model.dispose(); }
});

test('saved-operation continuation cannot carry an old click across a replacement baseline', { timeout: 15000 }, async t => {
  const first = makeEntry('first'); const h = controlled([first]); h.state.modes.set('first', 'pending-recovery'); const model = h.model();
  const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const read = h.api.getPurgeOperation;
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first)); model.acknowledgePurgeBatch(true);
    const paused = await model.runPurgeBatch(); const operationId = paused.items[0].plan.operationId;
    h.api.getPurgeOperation = async id => { entered.resolve(); await release.promise; return read(id); };
    const retry = model.retryPurge(operationId); await within(entered.promise, t.signal);
    await ready(model, t.signal); release.resolve(); await retry;
    assert.equal(model.getSnapshot().phase, 'ready'); assert.equal(h.state.executes.length, 1);
    assert.equal(model.getSnapshot().purgePending[0].operationId, operationId);
  } finally { release.resolve(); await model.dispose(); }
});

for (const boundary of ['journal-query', 'pending-publication']) {
  test(`fresh confirmation preserves protection when connection changes during ${boundary}`, { timeout: 15000 }, async t => {
    const first = makeEntry('first'); const h = controlled([first]); h.state.modes.set('first', 'missing'); const model = h.model();
    const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const read = h.api.getPurgeOperation;
    let off = () => {}; let refresh;
    try {
      await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(first)); model.acknowledgePurgeBatch(true);
      const paused = await model.runPurgeBatch(); const oldOperationId = paused.items[0].plan.operationId;
      const fresh = await model.preparePurgeAgain(oldOperationId, 'First again'); assert(fresh); model.acknowledgePurge(true);
      if (boundary === 'journal-query') {
        h.api.getPurgeOperation = async id => { entered.resolve(); await release.promise; return read(id); };
        const confirming = model.confirmPurge(); await within(entered.promise, t.signal);
        await ready(model, t.signal); release.resolve(); assert.equal(await confirming, undefined);
        assert.equal(model.getSnapshot().purgePending[0].operationId, oldOperationId);
      } else {
        let armed = true;
        off = model.subscribe(() => {
          if (armed && model.getSnapshot().purgePending[0]?.operationId === fresh.operationId) {
            armed = false; refresh = model.refresh();
          }
        });
        const result = await model.confirmPurge(); assert.equal(result.status, 'pending');
        await refresh; await waitFor(model, state => state.phase === 'ready', t.signal); await model.checkPurgePending();
        assert.equal(model.getSnapshot().purgePending[0].operationId, fresh.operationId);
        assert(model.getSnapshot().purgeBatchOperationIds.includes(fresh.operationId));
      }
      assert.equal(h.state.executes.length, 1, 'connection changes cannot dispatch the fresh plan');
    } finally { release.resolve(); off(); await model.dispose(); }
  });
}

test('more than 64 terminal targets complete with a one-plan admission cache window', { timeout: 30000 }, async t => {
  const entries = Array.from({ length: 70 }, (_, index) => makeEntry(`S${index}`)); const h = controlled(entries); const model = h.model();
  try {
    await ready(model, t.signal); const batch = await model.preparePurgeBatch({ kind: 'all-archived' });
    assert.equal(batch.frozenCount, 70); model.acknowledgePurgeBatch(true); const done = await model.runPurgeBatch();
    assert.equal(done.phase, 'done'); assert.equal(h.state.executes.length, 70); assert.equal(h.cache.peak(), 1);
    assert.equal(model.getSnapshot().purgePending.length, 0);
  } finally { await model.dispose(); }
});

test('an active batch rejects single preparation and any second batch', { timeout: 15000 }, async t => {
  const a = makeEntry('A'); const b = makeEntry('B'); const h = controlled([a, b]); const model = h.model();
  try {
    await ready(model, t.signal); await model.preparePurgeBatch(scopeOf(a, b));
    assert.equal(await model.preparePurge(a, 'Single A'), null); assert.equal(await model.preparePurgeBatch(scopeOf(a)), null);
    assert.equal(h.state.prepares.length, 2); model.stopPurgeBatch();
  } finally { await model.dispose(); }
});
