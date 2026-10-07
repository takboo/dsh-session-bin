import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import * as bin from '../dist/index.js';
import { createScratch, transcript, accounting } from './helpers/fixture.mjs';
import { latch, multiParticipantOptions, openRetirementFixture, override } from './helpers/retirement-owner.mjs';

const workerPath = new URL('./helpers/retirement-owner-worker.mjs', import.meta.url);
const grant = () => Promise.resolve({ authorized: true, authorizationId: randomUUID() });
async function requestFor(owner, operationId = randomUUID()) {
  const expected = await owner.inspect('quiet');
  assert(expected);
  const manifest = await owner.prepare(expected);
  return { manifest, request: { operationId, expected, bin: { entryId: randomUUID(), entryVersion: 1 },
    manifestDigest: bin.retirementManifestDigest(manifest) } };
}
async function open(root, ownerOptions = {}, extra = {}) {
  return openRetirementFixture(root, { seed: true, ownerOptions: multiParticipantOptions(ownerOptions), ...extra });
}
function observe(promise) { return promise.then(value => ({ value }), error => ({ error })); }
async function retired(owner, expected) {
  for (const { resource, record } of await owner.resourceSnapshot(expected)) {
    if (['erase', 'release-reference'].includes(resource.disposition)) assert.equal(record, null);
    else assert(record);
    if (resource.disposition === 'retain-shared') {
      assert.deepEqual(record.references, resource.retention.retainedBy.map(key => key.lifecycleId));
      for (const key of resource.retention.retainedBy) assert.deepEqual(owner.domain.table('protected').get(key.lifecycleId), key);
    }
  }
}
async function killed(root, selected, request) {
  const worker = fork(workerPath, [root, selected, JSON.stringify(request)], { silent: true });
  let stderr = '';
  let sent;
  let timedOut = false;
  worker.stdout.resume();
  worker.stderr.on('data', data => { stderr += data; });
  worker.on('message', message => { sent = message.request; });
  const deadline = setTimeout(() => { timedOut = true; worker.kill('SIGKILL'); }, 25000);
  try {
    const [code, signal] = await once(worker, 'exit');
    assert.equal(timedOut, false, stderr);
    assert.equal(code, null, stderr);
    assert.equal(signal, 'SIGKILL', stderr);
    assert.deepEqual(sent, request);
  } finally {
    clearTimeout(deadline);
    if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await once(worker, 'exit'); }
  }
}

test('production owner confirms every participant and lifecycle before success while preserving native resources', async t => {
  const root = await createScratch('owner-complete-');
  t.diagnostic(root);
  let fixture = await open(root);
  const nativeLog = await transcript(fixture);
  const nativeAccounting = accounting(fixture);
  let request;
  let manifest;
  let state;
  try {
    ({ request, manifest } = await requestFor(fixture.owner));
    state = await fixture.owner.retire(request, grant, manifest);
    assert.equal(state.phase, 'done');
    const record = fixture.owner.getRecord(request.operationId);
    assert(record.lifecycleQuiesced && record.lifecycleFinalized);
    assert(record.participants.every(participant => participant.fenced && participant.quiesced && participant.converged));
    const participantIds = manifest.capabilities.participants.map(participant => participant.id);
    for (const stage of ['fence', 'quiesce', 'converge']) {
      assert.deepEqual(fixture.owner.events.filter(event => event.name === `participant-${stage}`).map(event => event.participantId), participantIds);
    }
    const fenced = fixture.owner.checkpoints.find(checkpoint => checkpoint.name === 'owner-fenced').value.record;
    assert(fenced.participants.every(participant => !participant.fenced));
    const effects = fixture.owner.checkpoints.filter(checkpoint => checkpoint.name === 'resource-effect');
    assert(effects.every(checkpoint => checkpoint.value.record.lifecycleQuiesced
      && checkpoint.value.record.participants.every(participant => participant.fenced && participant.quiesced)));
    await retired(fixture.owner, request.expected);
    assert.deepEqual(await transcript(fixture), nativeLog);
    assert.deepEqual(accounting(fixture), nativeAccounting);
    await fixture.close();
    fixture = await open(root, {}, { seed: false });
    assert.deepEqual(await fixture.owner.getOperation(request.operationId), state);
    await retired(fixture.owner, request.expected);
    assert.equal(fixture.owner.effectCalls, 0, 'initialize only binds/verifies, never resumes erasure');
  } finally { await fixture.close(); }
});

test('owner refuses activity and requires a full frozen manifest before calling authorization', async () => {
  const fixture = await open(await createScratch('owner-admission-'), { activity: ['turn', 'job'] });
  let calls = 0;
  try {
    const { request, manifest } = await requestFor(fixture.owner);
    await assert.rejects(fixture.owner.coordinator.retire(request, async () => { calls += 1; return grant(); }), /manifest/);
    const state = await fixture.owner.retire(request, async () => { calls += 1; return grant(); }, manifest);
    assert.equal(state.phase, 'rejected');
    assert.equal(state.reason, 'session-active');
    assert.equal(calls, 0);
    assert.equal(fixture.owner.effectCalls, 0);
    assert(fixture.owner.getRecord(request.operationId).participants.every(participant => !participant.fenced));
  } finally { await fixture.close(); }
});

test('lifecycle scope excludes new fixture generations before authorization and always releases', async () => {
  const gate = latch();
  const fixture = await open(await createScratch('owner-exclusive-scope-'), { slowGate: { checkpoint: 'before-authorize', gate } });
  let operation;
  try {
    const { request, manifest } = await requestFor(fixture.owner);
    operation = observe(fixture.owner.retire(request, grant, manifest));
    await gate.entered;
    await assert.rejects(fixture.owner.createLifecycle('quiet'), /maintenance scope/);
    await assert.rejects(fixture.owner.appendFixtureResource(request.expected, 'new writer'), /maintenance scope/);
    gate.release();
    assert.equal((await operation).value.phase, 'done');
    assert.equal(fixture.owner.scopes.size, 0);
  } finally { gate.release(); await operation; await fixture.close(); }
});

test('quiescence waits for a real retained fixture operation and does not erase before settlement', { timeout: 15000 }, async () => {
  const useGate = latch();
  const barrierGate = latch();
  const fixture = await open(await createScratch('owner-retained-use-'), { lifecycleQuiesceGate: barrierGate });
  let use;
  let operation;
  try {
    const { request, manifest } = await requestFor(fixture.owner);
    use = observe(fixture.owner.startUse(request.expected, 'cache', useGate));
    await useGate.entered;
    operation = observe(fixture.owner.retire(request, grant, manifest));
    await barrierGate.entered;
    const record = fixture.owner.getRecord(request.operationId);
    assert.equal(record.state.phase, 'fenced');
    assert.equal(record.lifecycleQuiesced, false);
    assert.equal(fixture.owner.effectCalls, 0);
    barrierGate.release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.owner.effectCalls, 0);
    useGate.release();
    assert((await use).error, 'a retained reference must be invalidated by the fence');
    assert.equal((await operation).value.phase, 'done');
    assert.equal(fixture.owner.activeUses.size, 0);
  } finally { useGate.release(); barrierGate.release(); await use; await operation; await fixture.close(); }
});

test('a pre-admitted write published during drain holds the original quiesced fence instead of enlarging erasure', async () => {
  const useGate = latch();
  const barrierGate = latch();
  const fixture = await open(await createScratch('owner-drain-drift-'), { lifecycleQuiesceGate: barrierGate });
  let use;
  let operation;
  try {
    const { request, manifest } = await requestFor(fixture.owner);
    use = fixture.owner.startUse(request.expected, 'transcript', useGate, { admittedDrain: true, text: 'already-admitted durable write' });
    await useGate.entered;
    operation = fixture.owner.retire(request, grant, manifest);
    await barrierGate.entered;
    barrierGate.release(); useGate.release();
    await use;
    const state = await operation;
    assert.equal(state.phase, 'quiesced');
    const record = fixture.owner.getRecord(request.operationId);
    assert.equal(record.blockedReason, 'resource-scope-changed-after-quiescence');
    assert.equal(fixture.owner.effectCalls, 0);
    assert.equal((await fixture.owner.recover(request.operationId)).phase, 'quiesced');
    await assert.rejects(fixture.owner.createLifecycle('quiet'), /fences|fenced/);
  } finally { useGate.release(); barrierGate.release(); await operation; await fixture.close(); }
});

for (const stage of ['fence', 'quiesce', 'converge']) {
  test(`a pending participant ${stage} keeps its durable guard and resumes only the same operation`, async () => {
    const root = await createScratch('owner-participant-pending-');
    let fixture = await open(root, { participantPending: `fixture-derived:${stage}` });
    let request;
    try {
      const prepared = await requestFor(fixture.owner);
      request = prepared.request;
      const state = await fixture.owner.retire(request, grant, prepared.manifest);
      assert.notEqual(state.phase, 'done');
      assert(fixture.owner.getRecord(request.operationId).blockedReason.includes('pending'));
      await assert.rejects(fixture.owner.createLifecycle('quiet'), /fences|fenced/);
      await fixture.close();
      fixture = await open(root, {}, { seed: false });
      assert.equal(fixture.owner.effectCalls, 0);
      assert.equal((await fixture.owner.recover(request.operationId)).phase, 'done');
      assert.equal(fixture.owner.authorizeCalls, 0);
      await retired(fixture.owner, request.expected);
    } finally { await fixture.close(); }
  });
}

for (const fault of ['owner-id', 'resource-id', 'disposition']) {
  test(`participant ${fault} receipt corruption cannot acknowledge a resource or escape its fence`, async () => {
    const root = await createScratch('owner-invalid-participant-');
    let fixture = await open(root, { participantWrapper(participant) {
      return override(participant, { async applyResource(request, resource) {
        const receipt = await participant.applyResource(request, resource);
        if (fault === 'owner-id') receipt.ownerId = 'another-owner';
        else if (fault === 'resource-id') receipt.resourceId = 'another-resource';
        else { receipt.status = 'erased'; receipt.reason = null; }
        return receipt;
      } });
    } });
    let request;
    try {
      const prepared = await requestFor(fixture.owner);
      request = prepared.request;
      await assert.rejects(fixture.owner.retire(request, grant, prepared.manifest));
      const record = fixture.owner.rawOwnerStore.operation(request.operationId);
      assert.equal(record.state.phase, 'erasing');
      assert.equal(record.state.resources.length, 0);
      await assert.rejects(fixture.owner.createLifecycle('quiet'));
      await fixture.close();
      fixture = await open(root, {}, { seed: false });
      assert.equal((await fixture.owner.recover(request.operationId)).phase, 'done');
      await retired(fixture.owner, request.expected);
    } finally { await fixture.close(); }
  });
}

test('historical owner receipts and durable tombstones protect old references across new lifecycles and reopen', async () => {
  const root = await createScratch('owner-tombstone-');
  let fixture = await open(root);
  let prepared;
  let first;
  try {
    prepared = await requestFor(fixture.owner);
    const reference = fixture.owner.retainedReference(prepared.request.expected);
    first = await fixture.owner.retire(prepared.request, grant, prepared.manifest);
    await assert.rejects(reference.write('late cache'), /retired|fenced/);
    const lifecycle = await fixture.owner.createLifecycle('quiet');
    const resources = await fixture.owner.resourceSnapshot(lifecycle);
    assert.deepEqual(await fixture.owner.retire(prepared.request, async () => { throw new Error('historical request must not reauthorize'); }), first);
    assert.deepEqual(await fixture.owner.resourceSnapshot(lifecycle), resources);
    await fixture.close();
    fixture = await open(root, {}, { seed: false });
    assert.throws(() => fixture.owner.coordinator.guards.assertCanUse(prepared.request.expected), /retired|fenced/);
    fixture.owner.coordinator.guards.assertCanUse(lifecycle);
    assert.deepEqual(await fixture.owner.retire(prepared.request, async () => { throw new Error('no restart authorization'); }), first);
  } finally { await fixture.close(); }
});

for (const boundary of ['fence', 'resource-ack']) {
  test(`an owner journal ${boundary} write acknowledged durably then thrown pauses until a fresh reopen`, async () => {
    const root = await createScratch('owner-journal-io-');
    let injected = false;
    let fixture = await open(root, { ownerStoreWrapper(store) {
      return override(store, { async putOperation(record) {
        await store.putOperation(record);
        if (!injected && (boundary === 'fence' ? record.state.phase === 'fenced' : record.state.resources.length > 0)) {
          injected = true;
          throw new Error('injected owner journal lost acknowledgement');
        }
      } });
    } });
    let request;
    try {
      const prepared = await requestFor(fixture.owner);
      request = prepared.request;
      await assert.rejects(fixture.owner.retire(request, grant, prepared.manifest));
      assert(fixture.owner.rawOwnerStore.operation(request.operationId));
      await assert.rejects(fixture.owner.createLifecycle('quiet'), /ready|closing|reopen/);
      await fixture.close();
      fixture = await open(root, {}, { seed: false });
      assert.equal((await fixture.owner.recover(request.operationId)).phase, 'done');
      await retired(fixture.owner, request.expected);
    } finally { await fixture.close(); }
  });
}

test('failed fence persistence disables every guard immediately while scope release is still waiting', { timeout: 15000 }, async () => {
  const releaseGate = latch();
  let releases = 0;
  let mediumRecord;
  let fixture;
  fixture = await open(await createScratch('owner-release-window-'), { lifecycleWrapper(port) {
    return override(port, { async acquire(expected, maintenance) {
      const scope = await port.acquire(expected, maintenance);
      return override(scope, { async release() {
        releases += 1;
        if (releases > 1) await releaseGate.pause();
        await scope.release();
      } });
    } });
  } }, { beforeDomains(base) {
    const facet = base.ctx.storage.backend.get('json').kv;
    const originalOpen = facet.open;
    facet.open = async function (descriptor) {
      const unit = await originalOpen.call(facet, descriptor);
      if (descriptor.name !== bin.retirementOwnerDomainSpec.name) return unit;
      return override(unit, { async putRecord(table, key, value) {
        await unit.putRecord(table, key, value);
        if (table === 'operations' && value.state?.phase === 'fenced') {
          mediumRecord = (await unit.loadAll()).tables.operations[key];
          throw new Error('injected after backend commit before domain memory acknowledgement');
        }
      } });
    };
    return async () => { facet.open = originalOpen; };
  } });
  let operation;
  try {
    const prepared = await requestFor(fixture.owner);
    operation = observe(fixture.owner.retire(prepared.request, grant, prepared.manifest));
    await releaseGate.entered;
    assert.equal(mediumRecord.state.phase, 'fenced', 'the real backend has committed the retirement fence');
    assert.equal(fixture.owner.rawOwnerStore.operation(prepared.request.operationId), undefined,
      'the domain memory must actually remain older than the medium');
    assert.throws(() => fixture.owner.coordinator.guards.assertCanUse(prepared.request.expected));
    assert.throws(() => fixture.owner.coordinator.guards.assertCanCreate('sibling'));
    releaseGate.release();
    assert((await operation).error);
  } finally { releaseGate.release(); await operation; await fixture.close(); }
});

test('participant version drift during an awaited fence is sticky and never saves its acknowledgement', async () => {
  const gate = latch();
  let mutable;
  const fixture = await open(await createScratch('owner-version-window-'), { participantWrapper(participant) {
    if (participant.identity.id !== 'fixture-logs') return participant;
    mutable = { ...participant, identity: { ...participant.identity }, async fence(request) {
      await gate.pause(); return participant.fence(request);
    } };
    return mutable;
  } });
  let operation;
  try {
    const prepared = await requestFor(fixture.owner);
    operation = observe(fixture.owner.retire(prepared.request, grant, prepared.manifest));
    await gate.entered;
    mutable.identity.version = '2';
    assert.throws(() => fixture.owner.coordinator.guards.assertCanCreate('quiet'));
    gate.release();
    assert((await operation).error);
    const record = fixture.owner.rawOwnerStore.operation(prepared.request.operationId);
    assert(record.participants.every(participant => !participant.fenced));
    assert.equal(fixture.owner.effectCalls, 0);
  } finally { gate.release(); await operation; await fixture.close(); }
});

test('close drains guard registration and disables retained routes even when initialization is cancelled', { timeout: 15000 }, async () => {
  const gate = latch();
  const root = await createScratch('owner-init-close-');
  const fixture = await open(root, { deferInitialize: true, bindGates: { lifecycle: gate } }, { seed: false, skipReconcile: true });
  let initializing;
  let closing;
  let settled = false;
  try {
    initializing = observe(fixture.owner.initialize());
    await gate.entered;
    closing = observe(fixture.owner.close()).then(value => { settled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(bin.acquireBinLease(join(root, 'coordination')));
    gate.release();
    assert((await initializing).error);
    await closing;
    assert.equal(fixture.owner.lifecycleGuards, null);
    await assert.rejects(fixture.owner.createLifecycle('quiet'), /disabled|ready/);
  } finally { gate.release(); await initializing; await closing; await fixture.close().catch(() => {}); }
  const release = await bin.acquireBinLease(join(root, 'coordination'));
  await release();
});

test('parallel inspection failure while quiescence waits prevents acknowledgement and the next participant', async () => {
  const gate = latch();
  let failInspection = false;
  const fixture = await open(await createScratch('owner-inspect-window-'), {
    lifecycleWrapper(port) { return override(port, { async inspect(sessionId) {
      if (failInspection) throw new Error('injected parallel inspection failure');
      return port.inspect(sessionId);
    } }); }, participantWrapper(participant) {
      if (participant.identity.id !== 'fixture-logs') return participant;
      return override(participant, { async quiesce(request) { await gate.pause(); return participant.quiesce(request); } });
    },
  });
  let operation;
  try {
    const prepared = await requestFor(fixture.owner);
    operation = observe(fixture.owner.retire(prepared.request, grant, prepared.manifest));
    await gate.entered;
    failInspection = true;
    await assert.rejects(fixture.owner.inspect('sibling'));
    assert.throws(() => fixture.owner.coordinator.guards.assertCanCreate('sibling'));
    gate.release();
    assert((await operation).error);
    const record = fixture.owner.rawOwnerStore.operation(prepared.request.operationId);
    assert.equal(record.lifecycleQuiesced, true);
    assert(record.participants.every(participant => !participant.quiesced));
    assert.equal(fixture.owner.events.filter(event => event.name === 'participant-quiesce' && event.participantId === 'fixture-derived').length, 0);
    assert.equal(fixture.owner.effectCalls, 0);
  } finally { gate.release(); await operation; await fixture.close(); }
});

test('a standalone slow observation joins close before routes and journal are released', { timeout: 15000 }, async () => {
  const gate = latch();
  let slow = false;
  const fixture = await open(await createScratch('owner-control-close-'), { lifecycleWrapper(port) {
    return override(port, { async inspect(sessionId) { if (slow) await gate.pause(); return port.inspect(sessionId); } });
  } });
  let inspection;
  let closing;
  let settled = false;
  try {
    slow = true;
    inspection = observe(fixture.owner.inspect('quiet'));
    await gate.entered;
    closing = observe(fixture.owner.close()).then(value => { settled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert(fixture.owner.lifecycleGuards);
    assert.equal(fixture.owner.participantGuards.size, 3);
    assert(fixture.owner.journalDomain.global.get().capabilities);
    await assert.rejects(async () => fixture.owner.inspect('sibling'));
    await assert.rejects(async () => fixture.owner.capabilities());
    gate.release();
    await inspection;
    assert.equal((await closing).error, undefined);
    assert.equal(fixture.owner.lifecycleGuards, null);
    assert.equal(fixture.owner.participantGuards.size, 0);
  } finally { gate.release(); await inspection; await closing; await fixture.close(); }
});

test('an admitted internal authorization frame can finish control observations while external closing calls are refused', { timeout: 15000 }, async () => {
  const gate = latch();
  const fixture = await open(await createScratch('owner-inner-control-close-'), { slowGate: { checkpoint: 'before-authorize', gate } });
  let operation;
  let closing;
  try {
    const prepared = await requestFor(fixture.owner);
    operation = observe(fixture.owner.retire(prepared.request, async () => {
      const capabilities = await fixture.owner.capabilities();
      assert.equal(capabilities.storeId, prepared.request.expected.storeId);
      assert.deepEqual(await fixture.owner.inspect('quiet'), prepared.request.expected);
      return grant();
    }, prepared.manifest));
    await gate.entered;
    closing = observe(fixture.owner.coordinator.close());
    await assert.rejects(async () => fixture.owner.capabilities());
    gate.release();
    assert.equal((await operation).value?.phase, 'done');
    assert.equal((await closing).error, undefined);
  } finally { gate.release(); await operation; await closing; await fixture.close(); }
});

for (const boundary of ['lifecycle', 'participant-quiesced', 'participant-converged']) {
  test(`a false worker budget after ${boundary} confirmation cannot overrun the next durable step`, async () => {
    const fixture = await open(await createScratch('owner-budget-'), { canAdvance(record) {
      if (boundary === 'lifecycle') return !record.lifecycleQuiesced;
      if (boundary === 'participant-quiesced') return !record.participants.some(participant => participant.quiesced);
      return !record.participants.some(participant => participant.converged);
    } });
    try {
      const prepared = await requestFor(fixture.owner);
      const state = await fixture.owner.retire(prepared.request, grant, prepared.manifest);
      assert.notEqual(state.phase, 'done');
      const record = fixture.owner.getRecord(prepared.request.operationId);
      if (boundary === 'lifecycle') {
        assert(record.lifecycleQuiesced);
        assert(record.participants.every(participant => !participant.quiesced));
      } else if (boundary === 'participant-quiesced') {
        assert.equal(record.participants.filter(participant => participant.quiesced).length, 1);
        assert.equal(fixture.owner.effectCalls, 0);
      } else {
        assert.equal(record.participants.filter(participant => participant.converged).length, 1);
        assert.equal(record.lifecycleFinalized, false);
      }
      delete fixture.owner.options.canAdvance;
      assert.equal((await fixture.owner.recover(prepared.request.operationId)).phase, 'done');
    } finally { await fixture.close(); }
  });
}

for (const source of ['store-read', 'budget']) {
  test(`a falsy ${source} exception still closes the owner health fence`, async () => {
    let fail = false;
    const fixture = await open(await createScratch('owner-falsy-failure-'), {
      ...(source === 'store-read' ? { ownerStoreWrapper(store) { return override(store, { operations() {
        if (fail) throw 0;
        return store.operations();
      } }); } } : { canAdvance() { if (fail) throw 0; return true; } }),
    });
    try {
      const prepared = await requestFor(fixture.owner);
      fail = true;
      if (source === 'store-read') assert.throws(() => fixture.owner.coordinator.guards.assertCanUse(prepared.request.expected));
      else await assert.rejects(fixture.owner.retire(prepared.request, grant, prepared.manifest));
      assert.throws(() => fixture.owner.coordinator.guards.assertCanCreate('sibling'));
      await assert.rejects(async () => fixture.owner.capabilities());
      assert.equal(fixture.owner.effectCalls, 0);
    } finally { fail = false; await fixture.close(); }
  });
}

test('a scope returned just as participant identity drifts is still adopted and released', async () => {
  let mutable;
  let drift = false;
  let released = 0;
  const fixture = await open(await createScratch('owner-acquire-adopt-'), {
    participantWrapper(participant) {
      if (participant.identity.id !== 'fixture-logs') return participant;
      mutable = { ...participant, identity: { ...participant.identity } };
      return mutable;
    }, lifecycleWrapper(port) { return override(port, { async acquire(expected, maintenance) {
      const scope = await port.acquire(expected, maintenance);
      if (drift) mutable.identity.version = '2';
      return override(scope, { async release() { released += 1; await scope.release(); } });
    } }); },
  });
  try {
    const prepared = await requestFor(fixture.owner);
    const before = released;
    drift = true;
    await assert.rejects(fixture.owner.retire(prepared.request, grant, prepared.manifest));
    assert.equal(released, before + 1);
    assert.equal(fixture.owner.scopes.size, 0);
    assert.equal(fixture.owner.effectCalls, 0);
    assert.throws(() => fixture.owner.coordinator.guards.assertCanCreate('quiet'));
  } finally { await fixture.close(); }
});

test('a returned guard disposer is adopted before a post-bind identity failure and still disables its routes', async () => {
  let mutable;
  let disposed = 0;
  const fixture = await open(await createScratch('owner-bind-adopt-'), {
    deferInitialize: true,
    participantWrapper(participant) {
      if (participant.identity.id !== 'fixture-logs') return participant;
      mutable = { ...participant, identity: { ...participant.identity } };
      return mutable;
    }, lifecycleWrapper(port) { return override(port, { async bindGuards(guards) {
      const dispose = await port.bindGuards(guards);
      mutable.identity.version = '2';
      return async () => { disposed += 1; await dispose(); };
    } }); },
  }, { seed: false, skipReconcile: true });
  try {
    await assert.rejects(fixture.owner.initialize());
    await observe(fixture.owner.close());
    assert.equal(disposed, 1);
    assert.equal(fixture.owner.lifecycleGuards, null);
  } finally { await fixture.close().catch(() => {}); }
});

for (const action of ['prepare', 'retire']) {
  test(`an accepted slow scope.current ${action} completes and releases during close`, { timeout: 15000 }, async () => {
    const gate = latch();
    let slow = false;
    const fixture = await open(await createScratch('owner-current-close-'), { lifecycleWrapper(port) {
      return override(port, { async acquire(expected, maintenance) {
        const scope = await port.acquire(expected, maintenance);
        return override(scope, { async current() { if (slow) await gate.pause(); return scope.current(); } });
      } });
    } });
    let operation;
    let closing;
    try {
      const prepared = await requestFor(fixture.owner);
      slow = true;
      operation = observe(action === 'prepare' ? fixture.owner.prepare(prepared.request.expected)
        : fixture.owner.retire(prepared.request, grant, prepared.manifest));
      await gate.entered;
      closing = observe(fixture.owner.close());
      await assert.rejects(Promise.resolve().then(() => fixture.owner.inspect('sibling')));
      gate.release();
      const outcome = await operation;
      assert.equal(outcome.error, undefined);
      if (action === 'retire') assert.equal(outcome.value.phase, 'done');
      else assert.deepEqual(outcome.value, prepared.manifest);
      assert.equal((await closing).error, undefined);
      assert.equal(fixture.owner.scopes.size, 0);
    } finally { gate.release(); await operation; await closing; await fixture.close(); }
  });
}

for (const change of ['missing', 'replacement']) {
  test(`normal lifecycle ${change} before owner admission is a durable conflict without authorization`, async () => {
    const fixture = await open(await createScratch('owner-lifecycle-precondition-'));
    let authorized = 0;
    try {
      const prepared = await requestFor(fixture.owner);
      if (change === 'missing') await fixture.owner.domain.table('sessions').delete('quiet');
      else await fixture.owner.createLifecycle('quiet');
      const state = await fixture.owner.retire(prepared.request, async () => { authorized += 1; return grant(); }, prepared.manifest);
      assert.equal(state.phase, 'conflict');
      assert.equal(state.reason, 'lifecycle-changed');
      assert.equal(authorized, 0);
      assert.equal(fixture.owner.effectCalls, 0);
      const record = fixture.owner.getRecord(prepared.request.operationId);
      assert(record.participants.every(participant => !participant.fenced));
    } finally { await fixture.close(); }
  });
}

test('owner record validation rejects impossible acknowledgement ordering and immutable terminal changes', async () => {
  const fixture = await open(await createScratch('owner-record-schema-'));
  try {
    const prepared = await requestFor(fixture.owner);
    await fixture.owner.retire(prepared.request, grant, prepared.manifest);
    const complete = fixture.owner.getRecord(prepared.request.operationId);
    const invalid = structuredClone(complete);
    invalid.participants[0].converged = false;
    assert.equal(bin.retirementOwnerRecordSchema.safeParse(invalid).success, false);
    const impossible = structuredClone(complete);
    impossible.state.phase = 'fenced'; impossible.state.resources = []; impossible.lifecycleFinalized = false;
    impossible.participants.forEach(participant => { participant.fenced = false; participant.quiesced = false; participant.converged = false; });
    impossible.lifecycleQuiesced = true;
    assert.equal(bin.retirementOwnerRecordSchema.safeParse(impossible).success, false);
    await assert.rejects(async () => fixture.owner.rawOwnerStore.putOperation(invalid));
    assert.deepEqual(fixture.owner.getRecord(prepared.request.operationId), complete);
  } finally { await fixture.close(); }
});

test('actual owner process termination recovers every phase and participant acknowledgement without native erasure', { timeout: 180000 }, async t => {
  const participants = ['fixture-logs', 'fixture-derived', 'fixture-shared'];
  const checkpoints = ['owner-fenced', ...participants.map(id => `participant-fenced:${id}`), 'lifecycle-quiesced',
    ...participants.map(id => `participant-quiesced:${id}`), 'owner-quiesced', 'owner-erasing', 'resource-effect', 'resource-receipt',
    'owner-converging', ...participants.map(id => `participant-converged:${id}`), 'lifecycle-finalize-effect', 'lifecycle-finalized', 'owner-done'];
  for (const checkpoint of checkpoints) {
    const root = await createScratch('owner-crash-');
    t.diagnostic(`${checkpoint}: ${root}`);
    let fixture = await open(root);
    const prepared = await requestFor(fixture.owner, `owner-crash-${checkpoint}`);
    const nativeLog = await transcript(fixture);
    const nativeAccounting = accounting(fixture);
    await fixture.close();
    await killed(root, checkpoint, prepared.request);
    fixture = await open(root, {}, { seed: false });
    try {
      const before = await fixture.owner.getOperation(prepared.request.operationId);
      assert(before);
      if (before.phase !== 'done') await assert.rejects(fixture.owner.createLifecycle('quiet'));
      assert.throws(() => fixture.owner.coordinator.guards.assertCanUse(prepared.request.expected));
      const state = await fixture.owner.recover(prepared.request.operationId);
      assert.equal(state.phase, 'done', checkpoint);
      await retired(fixture.owner, prepared.request.expected);
      assert.deepEqual(await fixture.owner.retire(prepared.request, async () => { throw new Error('crash recovery cannot reauthorize'); }, prepared.manifest), state);
      assert.deepEqual(await transcript(fixture), nativeLog);
      assert.deepEqual(accounting(fixture), nativeAccounting);
      assert.equal(fixture.owner.authorizeCalls, 0);
    } finally { await fixture.close(); }
  }
});
