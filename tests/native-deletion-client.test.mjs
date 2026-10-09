import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SessionBinClientModel, browserPendingCache, retirementManifestDigest } from '../dist/client-model.js';
import { retirementManifestDigest as hostRetirementManifestDigest } from '../dist/index.js';
import { nativePurgePlanSchema } from '../dist/remote.js';
import { openRemoteFixture, within } from './helpers/remote-fixture.mjs';
import { createI18nHarness } from './helpers/i18n-harness.mjs';

const clone = value => structuredClone(value);
const entry = { schemaVersion: 2, sessionId: 'quiet', entryId: '74bdfb89-6a75-49a6-adc6-41c938cb8b01' };
const nonce = '76a1e295-eb03-4b20-9429-040b85b416a0';
const ok = value => ({ ok: true, value });
function planFor(operationId = randomUUID(), target = entry) {
  const lifecycle = { storeId: 'client-test-store', sessionId: target.sessionId, lifecycleId: 'client-test-lifecycle' };
  const capabilities = { protocolVersion: 1, ownerId: 'client-test-owner', hostVersion: 'test', providerId: 'test', storeId: lifecycle.storeId,
    participants: [{ id: 'client-test-resources', version: '1' }] };
  return { schemaVersion: 2, action: 'purge', operationId, sessionId: target.sessionId, expectedEntryId: target.entryId,
    binding: { schemaVersion: 2, target: 'native-archive', entryId: target.entryId, entryVersion: 2, lifecycle, capabilities },
    manifest: { schemaVersion: 1, lifecycle, capabilities, resources: [{ ownerId: 'client-test-resources', resourceId: 'client-test-log', revision: '1',
      kind: 'transcript', disposition: 'erase', retention: null }] }, blockers: [] };
}
function resultFor(plan, status = 'success', authorizationId = nonce) {
  const phase = status === 'success' ? 'done' : status === 'partial-failure' ? 'erasing' : 'fenced';
  const resources = status === 'success' ? [{ ownerId: 'client-test-resources', resourceId: 'client-test-log', status: 'erased', reason: null }]
    : status === 'partial-failure' ? [{ ownerId: 'client-test-resources', resourceId: 'client-test-log', status: 'failed', reason: 'client-test-failure' }] : [];
  return { action: 'purge', operationId: plan.operationId, sessionId: plan.sessionId, entryId: plan.expectedEntryId,
    status, reason: status === 'success' ? null : status === 'partial-failure' ? 'resource-failure' : 'owner-incomplete',
    ownerState: { schemaVersion: 1, request: { operationId: plan.operationId, expected: clone(plan.binding.lifecycle),
      bin: { kind: 'native-archive', entryId: plan.expectedEntryId, entryVersion: 2 }, manifestDigest: retirementManifestDigest(plan.manifest) },
    manifest: clone(plan.manifest), authorizationId, phase, reason: null, resources } };
}
function operationFor(plan, result) {
  return { schemaVersion: 2, plan: clone(plan), createdAt: '2026-10-07T10:00:00.000Z',
    phase: ['success', 'rejected', 'conflict'].includes(result.status) ? 'done' : 'owner-pending',
    entry: { schemaVersion: 2, sessionId: plan.sessionId, entryId: plan.expectedEntryId },
    authorizationId: result.ownerState?.authorizationId ?? null, ownerState: clone(result.ownerState), result: clone(result) };
}
function savedCache() {
  let reversible = [];
  let purgeEnvelope = { plans: [], grants: [], observationAttempts: [] };
  return { load: () => clone(reversible), save: plans => { reversible = clone(plans); },
    loadPurge: () => clone(purgeEnvelope.plans), savePurge: plans => {
      const active = new Set(plans.map(plan => plan.operationId));
      purgeEnvelope = { plans: clone(plans),
        grants: purgeEnvelope.grants.filter(grant => active.has(grant.operationId)),
        observationAttempts: purgeEnvelope.observationAttempts.filter(marker => active.has(marker.operationId)) };
    },
    loadPurgeGrants: () => clone(purgeEnvelope.grants), savePurgeGrants: grants => { purgeEnvelope.grants = clone(grants); },
    loadPurgeGrantObservations: () => clone(purgeEnvelope.observationAttempts),
    stagePurgeGrantObservation: operationId => {
      if (!purgeEnvelope.observationAttempts.some(marker => marker.operationId === operationId)) {
        purgeEnvelope.observationAttempts.push({ operationId });
      }
    } };
}
function memoryStorage(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) };
}
function streamFactory(state) {
  return () => {
    const stop = Promise.withResolvers(); const abort = new AbortController();
    return { dispose: async () => { abort.abort(); stop.resolve(); }, async *[Symbol.asyncIterator]() {
      yield { value: { schemaVersion: 2, entries: clone(state.entries) }, signal: abort.signal, accept() {} };
      await stop.promise;
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
function controlled() {
  const state = { entries: [entry], operations: new Map(), prepares: [], executes: [], unarchives: 0, mode: 'success', offline: false, missing: false, forged: false, revision: '1' };
  const cache = savedCache();
  const api = {
    async preparePurge(request) {
      state.prepares.push(clone(request)); const plan = planFor(request.operationId);
      plan.manifest.resources[0].revision = state.revision;
      return ok(plan);
    },
    async executePurge(plan) {
      state.executes.push(clone(plan));
      assert.equal(cache.loadPurge().find(row => row.operationId === plan.operationId)?.expectedEntryId, plan.expectedEntryId,
        'explicit confirmation saves the fixed plan before sending the irreversible request');
      if (state.missing) throw new Error('request did not reach the Host');
      const result = resultFor(plan, state.mode === 'lost' ? 'success' : state.mode);
      state.operations.set(plan.operationId, operationFor(plan, result));
      if (result.status === 'success') state.entries = [];
      if (state.mode === 'lost') throw new Error('reply lost after owner receipt');
      return ok(clone(result));
    },
    async getPurgeOperation(id) {
      if (state.offline) throw new Error('transport offline');
      const operation = state.operations.get(id);
      if (!operation) return ok(null);
      const snapshot = clone(operation);
      if (state.forged) snapshot.plan.manifest.resources[0].revision = 'forged';
      return ok(snapshot);
    },
    async purgeOperations() { return ok([...state.operations.values()].map(clone)); },
    async getOperation() { return ok(null); },
    async prepare() { state.unarchives += 1; throw new Error('guard should refuse unarchive before RPC'); },
  };
  return { state, api, cache, stream: streamFactory(state), model: () => new SessionBinClientModel(api, streamFactory(state), cache) };
}

// This tier injects transport outcomes and strictly shaped owner receipts. Real
// native file deletion and owner crash recovery are verified by the Host suite.
test('single deletion preparation and cancellation never execute or cache a destructive request', { timeout: 15000 }, async t => {
  const h = controlled(); const model = h.model();
  try {
    await ready(model, t.signal);
    const plan = await model.preparePurge(entry, '用户会话 Alpha'); assert.equal(plan.expectedEntryId, entry.entryId);
    assert.equal(model.getSnapshot().purgeConfirmation.title, '用户会话 Alpha');
    assert.equal(await model.confirmPurge(), undefined, 'unchecked confirmation cannot execute');
    assert.equal(h.cache.loadPurge().length, 0); model.cancelPurge();
    assert.equal(model.getSnapshot().purgeConfirmation, null); assert.equal(h.state.executes.length, 0);
  } finally { await model.dispose(); }
});

test('explicit acknowledged confirmation executes the privately frozen plan despite caller snapshot mutation', { timeout: 15000 }, async t => {
  const h = controlled(); const model = h.model();
  try {
    await ready(model, t.signal); const plan = await model.preparePurge(entry, 'Fixed target');
    const expected = clone(plan); plan.manifest.resources[0].revision = 'caller mutation';
    model.getSnapshot().purgeConfirmation.plan.expectedEntryId = randomUUID();
    model.acknowledgePurge(true); assert.equal((await model.confirmPurge()).status, 'success');
    assert.deepEqual(h.state.executes, [expected]); assert.equal(h.cache.loadPurge().length, 0);
    assert.equal(model.getSnapshot().notice.kind, 'deleted');
  } finally { await model.dispose(); }
});

test('a preparation for a replacement observation cannot open deletion confirmation', { timeout: 15000 }, async t => {
  const h = controlled(); h.api.preparePurge = async request => ok(planFor(request.operationId, { ...entry, entryId: randomUUID() }));
  const model = h.model();
  try {
    await ready(model, t.signal); assert.equal(await model.preparePurge(entry, 'Old selection'), null);
    assert.equal(model.getSnapshot().error, 'entry-changed'); assert.equal(model.getSnapshot().purgeConfirmation, null);
    assert.equal(h.state.executes.length, 0);
  } finally { await model.dispose(); }
});

test('writer and owner blockers remain non-executable even when acknowledgement is set', { timeout: 15000 }, async t => {
  const h = controlled(); h.api.preparePurge = async request => ok({ ...planFor(request.operationId), blockers: [{ code: 'jsonl/writer-active' }] });
  const model = h.model();
  try {
    await ready(model, t.signal); await model.preparePurge(entry, 'Blocked target'); model.acknowledgePurge(true);
    assert.equal(await model.confirmPurge(), undefined); assert.equal(h.state.executes.length, 0); assert.equal(h.cache.loadPurge().length, 0);
    assert.equal(model.getSnapshot().purgeConfirmation.plan.blockers[0].code, 'jsonl/writer-active');
  } finally { await model.dispose(); }
});

test('a lost irreversible reply survives reload and only queries the saved operation', { timeout: 15000 }, async t => {
  const h = controlled(); h.state.mode = 'lost'; h.state.offline = true; let model = h.model();
  try {
    await ready(model, t.signal); await model.preparePurge(entry, 'Loss'); model.acknowledgePurge(true);
    assert.equal((await model.confirmPurge()).status, 'pending');
    assert.equal(h.cache.loadPurge().length, 1); assert.deepEqual(h.cache.loadPurgeGrantObservations(), []);
    assert(model.getSnapshot().busy.includes(entry.sessionId));
    assert.equal((await model.unarchive(entry)).status, 'pending'); assert.equal(h.state.unarchives, 0);
    await model.dispose(); h.state.offline = false; model = h.model();
    await ready(model, t.signal); await waitFor(model, snapshot => snapshot.purgePending.length === 0, t.signal);
    assert.equal(h.state.executes.length, 1); assert.equal(h.state.prepares.length, 1);
    assert.equal(model.getSnapshot().notice.kind, 'deleted'); assert.deepEqual(h.cache.loadPurge(), []);
  } finally { await model.dispose(); }
});

test('a missing deletion is never replayed, including explicit retry; new scope needs fresh confirmation', { timeout: 15000 }, async t => {
  const h = controlled(); h.state.missing = true; const model = h.model();
  try {
    await ready(model, t.signal); const old = await model.preparePurge(entry, 'Original'); model.acknowledgePurge(true);
    const unknown = await model.confirmPurge(); assert.equal(unknown.reason, 'deletion-result-missing');
    await model.checkPurgePending(); await model.retryPurge(old.operationId);
    assert.equal(h.state.executes.length, 1); assert.equal(h.state.prepares.length, 1);
    h.state.revision = '2'; const next = await model.preparePurgeAgain(old.operationId, 'Original');
    assert.notEqual(next.operationId, old.operationId); assert.equal(next.expectedEntryId, old.expectedEntryId);
    assert.equal(next.manifest.resources[0].revision, '2'); assert.equal(h.state.executes.length, 1);
    assert.equal(model.getSnapshot().purgeConfirmation.acknowledged, false); assert.equal(await model.confirmPurge(), undefined);
    h.state.missing = false; model.acknowledgePurge(true); assert.equal((await model.confirmPurge()).status, 'success');
    assert.equal(h.state.executes.length, 2); assert.equal(h.state.executes[1].operationId, next.operationId);
  } finally { await model.dispose(); }
});

test('a missing old observation can be explicitly discarded without selecting or deleting its replacement', { timeout: 15000 }, async t => {
  const h = controlled(); h.state.missing = true; const model = h.model();
  try {
    await ready(model, t.signal); const old = await model.preparePurge(entry, 'Old observation'); model.acknowledgePurge(true); await model.confirmPurge();
    const replacement = { ...entry, entryId: randomUUID() }; h.state.entries = [replacement]; await model.refresh();
    await waitFor(model, snapshot => snapshot.entries[0]?.entryId === replacement.entryId, t.signal);
    assert.equal(await model.preparePurgeAgain(old.operationId, 'Replacement'), null);
    assert.equal(h.state.prepares.length, 1); assert.equal(h.state.executes.length, 1);
    assert.equal(await model.discardMissingPurge(old.operationId), true);
    assert.equal(model.getSnapshot().purgeConfirmation, null); assert.equal(h.state.prepares.length, 1); assert.equal(h.state.executes.length, 1);
    h.api.preparePurge = async request => ok(planFor(request.operationId, replacement));
    const next = await model.preparePurge(replacement, 'Explicit replacement');
    assert.equal(next.expectedEntryId, replacement.entryId); assert.equal(model.getSnapshot().purgeConfirmation.acknowledged, false);
    assert.equal(h.state.executes.length, 1); model.cancelPurge();
  } finally { await model.dispose(); }
});

for (const mode of ['pending-recovery', 'partial-failure']) test(`${mode} remains guarded and explicit continuation uses only its known saved binding`, { timeout: 15000 }, async t => {
  const h = controlled(); h.state.mode = mode; const model = h.model();
  try {
    await ready(model, t.signal); const plan = await model.preparePurge(entry, 'Interrupted'); model.acknowledgePurge(true);
    assert.equal((await model.confirmPurge()).status, mode); assert(model.getSnapshot().busy.includes(entry.sessionId));
    assert.equal((await model.unarchive(entry)).status, 'pending'); assert.equal(h.state.unarchives, 0);
    await model.checkPurgePending(); assert.equal(h.state.executes.length, 1);
    h.state.mode = 'success'; assert.equal((await model.retryPurge(plan.operationId)).status, 'success');
    assert.equal(h.state.prepares.length, 1); assert.deepEqual(h.state.executes, [plan, plan]); assert.deepEqual(h.cache.loadPurge(), []);
  } finally { await model.dispose(); }
});

test('a changed historical deletion plan cannot release the client guard or be explicitly continued', { timeout: 15000 }, async t => {
  const h = controlled(); h.state.mode = 'pending-recovery'; const model = h.model();
  try {
    await ready(model, t.signal); const plan = await model.preparePurge(entry, 'Exact plan'); model.acknowledgePurge(true); await model.confirmPurge();
    h.state.forged = true; await model.checkPurgePending(); await model.retryPurge(plan.operationId);
    assert.equal(h.state.executes.length, 1); assert.equal(h.cache.loadPurge().length, 1);
    assert.equal(h.cache.loadPurge()[0].manifest.resources[0].revision, '1'); assert(model.getSnapshot().busy.includes(entry.sessionId));
  } finally { await model.dispose(); }
});

test('a direct result with a manifest digest that does not authenticate its manifest stays guarded', { timeout: 15000 }, async t => {
  const h = controlled();
  h.api.executePurge = async plan => {
    h.state.executes.push(clone(plan));
    const result = resultFor(plan); result.ownerState.request.manifestDigest = 'b'.repeat(64);
    return ok(result);
  };
  const model = h.model();
  try {
    await ready(model, t.signal); await model.preparePurge(entry, 'Digest mismatch'); model.acknowledgePurge(true);
    const outcome = await model.confirmPurge();
    assert.equal(outcome.status, 'pending'); assert.notEqual(model.getSnapshot().notice?.kind, 'deleted');
    assert.equal(h.cache.loadPurge().length, 1); assert(model.getSnapshot().busy.includes(entry.sessionId));
  } finally { await model.dispose(); }
});

test('a completion with a different grant cannot clear a pending deletion', { timeout: 15000 }, async t => {
  const h = controlled(); h.state.mode = 'pending-recovery'; const model = h.model();
  try {
    await ready(model, t.signal); const plan = await model.preparePurge(entry, 'Grant continuity'); model.acknowledgePurge(true);
    assert.equal((await model.confirmPurge()).status, 'pending-recovery');
    assert.deepEqual(h.cache.loadPurgeGrants(), [{ operationId: plan.operationId, authorizationId: nonce }]);
    const changedGrant = randomUUID();
    h.api.executePurge = async input => {
      h.state.executes.push(clone(input));
      const result = resultFor(input, 'success', changedGrant);
      h.state.operations.set(input.operationId, operationFor(input, result));
      return ok(clone(result));
    };
    const outcome = await model.retryPurge(plan.operationId);
    assert.equal(outcome.status, 'pending'); assert.notEqual(model.getSnapshot().notice?.kind, 'deleted');
    assert.equal(h.cache.loadPurge().length, 1); assert(model.getSnapshot().busy.includes(entry.sessionId));
    assert.deepEqual(h.cache.loadPurgeGrants(), [{ operationId: plan.operationId, authorizationId: nonce }]);
  } finally { await model.dispose(); }
});

for (const mode of ['absent-owner', 'null-grant']) test(`an admitted deletion cannot be released by ${mode} refusal`, { timeout: 15000 }, async t => {
  const h = controlled(); h.state.mode = 'pending-recovery'; const model = h.model();
  try {
    await ready(model, t.signal); const plan = await model.preparePurge(entry, 'Admitted target'); model.acknowledgePurge(true);
    assert.equal((await model.confirmPurge()).status, 'pending-recovery');
    assert.deepEqual(h.cache.loadPurgeGrantObservations(), [{ operationId: plan.operationId }]);
    h.api.executePurge = async input => {
      h.state.executes.push(clone(input));
      const result = resultFor(input, 'pending-recovery');
      result.status = 'conflict'; result.reason = 'owner-refused';
      if (mode === 'absent-owner') result.ownerState = null;
      else { result.ownerState.phase = 'conflict'; result.ownerState.authorizationId = null; result.ownerState.reason = 'owner-refused'; }
      h.state.operations.set(input.operationId, operationFor(input, result));
      return ok(clone(result));
    };
    assert.equal((await model.retryPurge(plan.operationId)).status, 'pending');
    await model.checkPurgePending();
    assert.equal(h.cache.loadPurge().length, 1); assert(model.getSnapshot().busy.includes(entry.sessionId));
    assert.deepEqual(h.cache.loadPurgeGrants(), [{ operationId: plan.operationId, authorizationId: nonce }]);
    assert.notEqual(model.getSnapshot().notice?.kind, 'deleted');
  } finally { await model.dispose(); }
});

test('a journal receipt with a mismatched manifest digest cannot release the deletion guard', { timeout: 15000 }, async t => {
  const h = controlled(); h.state.mode = 'pending-recovery'; const model = h.model();
  try {
    await ready(model, t.signal); const plan = await model.preparePurge(entry, 'Journal digest'); model.acknowledgePurge(true);
    await model.confirmPurge();
    const result = resultFor(plan, 'success'); result.ownerState.request.manifestDigest = 'b'.repeat(64);
    h.state.operations.set(plan.operationId, operationFor(plan, result));
    await model.checkPurgePending();
    assert.equal(model.getSnapshot().purgePending.length, 1); assert(model.getSnapshot().busy.includes(entry.sessionId));
    assert.notEqual(model.getSnapshot().notice?.kind, 'deleted'); assert.equal(h.state.executes.length, 1);
  } finally { await model.dispose(); }
});

test('an observed grant survives reload and rejects a changed journal completion', { timeout: 15000 }, async t => {
  const h = controlled(); h.state.mode = 'pending-recovery'; let model = h.model();
  try {
    await ready(model, t.signal); const plan = await model.preparePurge(entry, 'Reload grant'); model.acknowledgePurge(true);
    await model.confirmPurge(); assert.deepEqual(h.cache.loadPurgeGrants(), [{ operationId: plan.operationId, authorizationId: nonce }]);
    await model.dispose();
    h.state.operations.set(plan.operationId, operationFor(plan, resultFor(plan, 'success', randomUUID())));
    model = h.model(); await ready(model, t.signal); await new Promise(resolve => setImmediate(resolve));
    assert.equal(model.getSnapshot().purgePending.length, 1); assert(model.getSnapshot().busy.includes(entry.sessionId));
    assert.notEqual(model.getSnapshot().notice?.kind, 'deleted'); assert.equal(h.state.executes.length, 1);
    assert.deepEqual(h.cache.loadPurgeGrants(), [{ operationId: plan.operationId, authorizationId: nonce }]);
  } finally { await model.dispose(); }
});

test('a staged grant whose snapshot writer fails becomes uncertain after reload and cannot adopt another nonce', { timeout: 15000 }, async t => {
  const h = controlled(); h.state.mode = 'pending-recovery';
  h.cache.savePurgeGrants = () => { throw new Error('grant writer unavailable'); };
  let model = h.model();
  try {
    await ready(model, t.signal); const plan = await model.preparePurge(entry, 'Writer failure'); model.acknowledgePurge(true);
    assert.equal((await model.confirmPurge()).status, 'pending');
    assert.deepEqual(h.cache.loadPurgeGrantObservations(), [{ operationId: plan.operationId }]);
    assert.deepEqual(h.cache.loadPurgeGrants(), []); assert.equal(model.getSnapshot().purgePending.length, 1);
    await model.dispose();
    h.state.operations.set(plan.operationId, operationFor(plan, resultFor(plan, 'success', randomUUID())));
    model = h.model(); await ready(model, t.signal); await new Promise(resolve => setImmediate(resolve));
    assert.equal(model.getSnapshot().purgePending.length, 1); assert(model.getSnapshot().busy.includes(entry.sessionId));
    assert.notEqual(model.getSnapshot().notice?.kind, 'deleted');
    h.state.operations.delete(plan.operationId);
    assert.equal(await model.preparePurgeAgain(plan.operationId, 'Unsafe replacement'), null);
    assert.equal(await model.discardMissingPurge(plan.operationId), false);
    assert.equal(h.state.prepares.length, 1); assert.equal(model.getSnapshot().purgePending.length, 1);
  } finally { await model.dispose(); }
});

for (const failure of ['reader-failure', 'legacy-methods-missing']) test(`a loaded pending deletion with ${failure} cannot adopt a replacement nonce`, { timeout: 15000 }, async t => {
  const h = controlled(); h.state.mode = 'pending-recovery'; let model = h.model();
  try {
    await ready(model, t.signal); const plan = await model.preparePurge(entry, 'Unreadable continuity'); model.acknowledgePurge(true);
    assert.equal((await model.confirmPurge()).status, 'pending-recovery'); await model.dispose();
    h.state.operations.set(plan.operationId, operationFor(plan, resultFor(plan, 'success', randomUUID())));
    if (failure === 'reader-failure') {
      h.cache.loadPurgeGrants = () => { throw new Error('grant reader unavailable'); };
      h.cache.loadPurgeGrantObservations = () => { throw new Error('observation reader unavailable'); };
    } else {
      delete h.cache.loadPurgeGrants; delete h.cache.savePurgeGrants;
      delete h.cache.loadPurgeGrantObservations; delete h.cache.stagePurgeGrantObservation;
    }
    model = h.model(); await ready(model, t.signal); await new Promise(resolve => setImmediate(resolve));
    assert.equal(model.getSnapshot().purgePending.length, 1); assert(model.getSnapshot().busy.includes(entry.sessionId));
    assert.notEqual(model.getSnapshot().notice?.kind, 'deleted'); assert.equal(h.state.executes.length, 1);
  } finally { await model.dispose(); }
});

test('a failed first observation marker write never accepts or announces that nonce', { timeout: 15000 }, async t => {
  const h = controlled(); h.cache.stagePurgeGrantObservation = () => { throw new Error('marker writer unavailable'); };
  const model = h.model();
  try {
    await ready(model, t.signal); const plan = await model.preparePurge(entry, 'Marker failure'); model.acknowledgePurge(true);
    assert.equal((await model.confirmPurge()).status, 'pending');
    assert.deepEqual(h.cache.loadPurgeGrantObservations(), []); assert.deepEqual(h.cache.loadPurgeGrants(), []);
    assert.equal(model.getSnapshot().purgePending.length, 1); assert(model.getSnapshot().busy.includes(entry.sessionId));
    assert.notEqual(model.getSnapshot().notice?.kind, 'deleted');
    h.state.operations.set(plan.operationId, operationFor(plan, resultFor(plan, 'success', randomUUID())));
    await model.checkPurgePending();
    assert.equal(model.getSnapshot().purgePending.length, 1); assert.notEqual(model.getSnapshot().notice?.kind, 'deleted');
  } finally { await model.dispose(); }
});

test('browser manifest digest matches Host canonical inventory ordering', () => {
  const plan = planFor();
  plan.binding.capabilities.participants.push({ id: 'client-test-cache', version: '1' });
  plan.manifest.resources.push({ ownerId: 'client-test-cache', resourceId: 'cache', revision: '1', kind: 'cache', disposition: 'erase', retention: null });
  const reordered = clone(plan.manifest); reordered.capabilities.participants.reverse(); reordered.resources.reverse();
  assert.equal(retirementManifestDigest(plan.manifest), hostRetirementManifestDigest(plan.manifest));
  assert.equal(retirementManifestDigest(reordered), retirementManifestDigest(plan.manifest));
});

test('equivalent inventory order in a matching owner receipt can confirm completion', { timeout: 15000 }, async t => {
  const h = controlled(); h.state.mode = 'pending-recovery';
  h.api.preparePurge = async request => {
    const plan = planFor(request.operationId); plan.binding.capabilities.participants.push({ id: 'client-test-cache', version: '1' });
    plan.manifest.resources.push({ ownerId: 'client-test-cache', resourceId: 'cache', revision: '1', kind: 'cache', disposition: 'erase', retention: null });
    return ok(plan);
  };
  const originalQuery = h.api.getPurgeOperation;
  const model = h.model();
  try {
    await ready(model, t.signal); await model.preparePurge(entry, 'Same scope'); model.acknowledgePurge(true); await model.confirmPurge();
    h.api.getPurgeOperation = async id => {
      const response = await originalQuery(id); const operation = response.value;
      operation.plan.binding.capabilities.participants.reverse(); operation.plan.manifest.capabilities.participants.reverse(); operation.plan.manifest.resources.reverse();
      const state = clone(operation.ownerState); state.manifest.capabilities.participants.reverse(); state.manifest.resources.reverse(); state.phase = 'done';
      state.resources = state.manifest.resources.map(resource => ({ ownerId: resource.ownerId, resourceId: resource.resourceId, status: 'erased', reason: null }));
      operation.phase = 'done'; operation.ownerState = state; operation.result = { ...operation.result, status: 'success', reason: null, ownerState: clone(state) };
      return ok(operation);
    };
    await model.checkPurgePending(); assert.equal(model.getSnapshot().purgePending.length, 0);
    assert.equal(model.getSnapshot().notice.kind, 'deleted'); assert.equal(h.state.executes.length, 1);
  } finally { await model.dispose(); }
});

test('an execution refusal naming a different entry cannot clear the fixed deletion guard', { timeout: 15000 }, async t => {
  const h = controlled(); h.api.executePurge = async plan => ok({ action: 'purge', operationId: plan.operationId, sessionId: plan.sessionId,
    entryId: randomUUID(), status: 'rejected', reason: 'permanent-deletion-unsupported', ownerState: null });
  const model = h.model();
  try {
    await ready(model, t.signal); await model.preparePurge(entry, 'Fixed entry'); model.acknowledgePurge(true);
    assert.equal((await model.confirmPurge()).status, 'pending'); assert.equal(h.cache.loadPurge().length, 1);
    assert.equal(h.cache.loadPurge()[0].expectedEntryId, entry.entryId); assert(model.getSnapshot().busy.includes(entry.sessionId));
  } finally { await model.dispose(); }
});

test('a new page with no browser cache discovers unfinished Host deletions without executing them', { timeout: 15000 }, async t => {
  const h = controlled(); h.state.mode = 'partial-failure'; let model = h.model();
  try {
    await ready(model, t.signal); const plan = await model.preparePurge(entry, 'Durable guard'); model.acknowledgePurge(true); await model.confirmPurge();
    await model.dispose(); model = new SessionBinClientModel(h.api, h.stream);
    await ready(model, t.signal); await waitFor(model, snapshot => snapshot.purgePending.length === 1, t.signal);
    assert.equal(model.getSnapshot().purgePending[0].operationId, plan.operationId);
    assert(model.getSnapshot().busy.includes(entry.sessionId)); assert.equal(h.state.executes.length, 1);
    assert.equal((await model.unarchive(entry)).status, 'pending'); assert.equal(h.state.unarchives, 0);
  } finally { await model.dispose(); }
});

test('a delayed unfinished journal snapshot cannot revive a deletion already confirmed complete', { timeout: 15000 }, async t => {
  const h = controlled(); const gate = Promise.withResolvers(); const entered = Promise.withResolvers();
  let pendingSnapshot = [];
  h.api.purgeOperations = async () => { entered.resolve(); await gate.promise; return ok(pendingSnapshot); };
  const model = h.model();
  try {
    await ready(model, t.signal); await within(entered.promise, t.signal);
    const plan = await model.preparePurge(entry, 'No resurrection'); model.acknowledgePurge(true); await model.confirmPurge();
    pendingSnapshot = [operationFor(plan, resultFor(plan, 'pending-recovery'))]; gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(model.getSnapshot().purgePending.length, 0); assert.equal(model.getSnapshot().busy.length, 0);
    assert.equal(model.getSnapshot().notice.kind, 'deleted'); assert.equal(h.state.executes.length, 1);
  } finally { gate.resolve(); await model.dispose(); }
});

test('deletion cache migrates legacy arrays and grants into one filtered versioned envelope', () => {
  const valid = planFor(); const missingGrant = planFor(randomUUID());
  const legacy = { ...valid, schemaVersion: 1, binding: { ...valid.binding, schemaVersion: 1, entryVersion: 1 } }; delete legacy.binding.target;
  const storage = memoryStorage({ 'dsh-session-bin.pending.v1': JSON.stringify([{ schemaVersion: 1, operationId: 'old-bin', action: 'bin', sessionId: 'quiet',
    expected: { archived: false, entryId: null }, blockers: [] }]),
  'dsh-session-bin.purge.pending.v2': JSON.stringify([legacy, { invalid: true }, valid, missingGrant]),
  'dsh-session-bin.purge.grants.v2': JSON.stringify([{ operationId: valid.operationId, authorizationId: nonce },
    { operationId: missingGrant.operationId, authorizationId: 'not-a-uuid' }]) });
  const cache = browserPendingCache(storage);
  assert.equal(cache.load()[0].operationId, 'old-bin'); assert.deepEqual(cache.loadPurge(), [valid, missingGrant]);
  assert.deepEqual(cache.loadPurgeGrants(), [{ operationId: valid.operationId, authorizationId: nonce }]);
  assert.deepEqual(cache.loadPurgeGrantObservations(), [{ operationId: missingGrant.operationId }],
    'a missing grant in the non-atomic legacy layout is not trusted as a first-observation baseline');
  const envelope = JSON.parse(storage.getItem('dsh-session-bin.purge.pending.v2'));
  assert.equal(envelope.schemaVersion, 1); assert.deepEqual(envelope.plans, [valid, missingGrant]);
  assert.deepEqual(envelope.grants, [{ operationId: valid.operationId, authorizationId: nonce }]);
  assert.deepEqual(envelope.observationAttempts, [{ operationId: missingGrant.operationId }]);
  assert.deepEqual(envelope.batchOperations, []);
  assert.equal(storage.getItem('dsh-session-bin.purge.grants.v2'), null);
  cache.savePurgeGrants([{ operationId: valid.operationId, authorizationId: nonce }, { operationId: 'malformed', authorizationId: 'not-a-uuid' }]);
  assert.deepEqual(browserPendingCache(storage).loadPurgeGrants(), [{ operationId: valid.operationId, authorizationId: nonce }]);
  assert.deepEqual(browserPendingCache(storage).loadPurgeGrantObservations(), [{ operationId: missingGrant.operationId }]);
  cache.savePurge([valid, missingGrant], [valid.operationId, 'not-active']);
  assert.deepEqual(browserPendingCache(storage).loadPurgeBatchOperations(), [valid.operationId]);
  cache.save([]); assert.deepEqual(cache.loadPurge(), [valid, missingGrant]); cache.savePurge([]);
  assert.deepEqual(cache.loadPurgeBatchOperations(), []);
  assert.equal(storage.getItem('dsh-session-bin.purge.pending.v2'), null); assert.equal(storage.getItem('dsh-session-bin.purge.grants.v2'), null);
  assert.equal(storage.getItem('dsh-session-bin.pending.v1'), null);
});

test('purge cache overflow preserves every guard and original bytes while deletion sends fail closed', async () => {
  const plans = Array.from({ length: 65 }, () => planFor());
  const grants = plans.map(plan => ({ operationId: plan.operationId, authorizationId: randomUUID() }));
  const observationAttempts = plans.map(plan => ({ operationId: plan.operationId }));
  const batchOperations = plans.map(plan => plan.operationId);
  const encoded = JSON.stringify({ schemaVersion: 1, plans, grants, observationAttempts, batchOperations });
  const storage = memoryStorage({ 'dsh-session-bin.purge.pending.v2': encoded });
  const cache = browserPendingCache(storage);
  assert.equal(cache.loadPurge().length, 65); assert.equal(cache.loadPurgeGrants().length, 65);
  assert.equal(cache.loadPurgeGrantObservations().length, 65); assert.equal(cache.loadPurgeBatchOperations().length, 65);
  assert.equal(cache.isPurgeCacheBlocked(), true);
  assert.throws(() => cache.savePurge([]), /capacity/i);
  assert.throws(() => cache.savePurgeGrants([]), /capacity/i);
  assert.throws(() => cache.stagePurgeGrantObservation(plans[0].operationId), /capacity/i);
  assert.equal(storage.getItem('dsh-session-bin.purge.pending.v2'), encoded, 'overflow must preserve the exact primary cache bytes');

  let prepares = 0; let executes = 0; let queries = 0;
  const api = { async preparePurge() { prepares += 1; throw new Error('must not prepare'); },
    async executePurge() { executes += 1; throw new Error('must not execute'); },
    async getPurgeOperation() { queries += 1; return ok(null); }, async purgeOperations() { return ok([]); },
    async getOperation() { return ok(null); }, async prepare() { throw new Error('unexpected unarchive'); } };
  const model = new SessionBinClientModel(api, streamFactory({ entries: [entry] }), cache);
  try {
    assert.equal(model.getSnapshot().purgeCacheBlocked, true); assert.equal(model.getSnapshot().purgePending.length, 65);
    assert.equal(model.getSnapshot().purgeBatchOperationIds.length, 65);
    assert.equal(await model.preparePurge(entry, 'Blocked by cache capacity'), null);
    assert.equal(await model.retryPurge(plans[0].operationId), undefined);
    await model.checkPurgePending(); assert.equal(queries, 65, 'read-only journal queries remain available');
    assert.equal(prepares, 0); assert.equal(executes, 0); assert.equal(model.getSnapshot().purgePending.length, 65);
    assert.equal(model.getSnapshot().error, 'purge-cache-capacity');
    assert.equal(storage.getItem('dsh-session-bin.purge.pending.v2'), encoded);
  } finally { await model.dispose(); }
});

test('strict deletion RPC rejects v1, paths, extra arguments, and aborted execution; query still accepts v1 history', { timeout: 15000 }, async () => {
  const fixture = await openRemoteFixture(); let executions = 0;
  try {
    await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
    const target = (await fixture.bin.list())[0]; const plan = planFor(randomUUID(), target);
    fixture.bin.preparePurge = async request => ({ ...clone(plan), operationId: request.operationId ?? plan.operationId });
    fixture.bin.executePurge = async input => { executions += 1; return { action: 'purge', operationId: input.operationId,
      sessionId: input.sessionId, entryId: input.expectedEntryId, status: 'rejected', reason: 'permanent-deletion-unsupported', ownerState: null }; };
    assert.equal((await fixture.api.preparePurge({ sessionId: 'quiet' })).ok, true);
    const legacy = { ...clone(plan), schemaVersion: 1, binding: { ...clone(plan.binding), schemaVersion: 1, entryVersion: 1 } }; delete legacy.binding.target;
    assert.equal(nativePurgePlanSchema.safeParse(legacy).success, false);
    for (const input of [legacy, { ...plan, path: '/arbitrary' }]) {
      const invalid = await fixture.api.executePurge(input); assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'gateway/input-invalid');
    }
    const extra = await fixture.client.connection.rpc.call('/api', 'sessionBin/executePurge', { args: { plan, arbitrary: 'field' } });
    assert.equal(extra.ok, false); assert.equal(extra.error.code, 'gateway/arguments-invalid');
    const controller = new AbortController(); controller.abort(); assert.equal((await fixture.api.executePurge(plan, controller.signal)).ok, false);
    assert.equal(executions, 0);
    const accepted = await fixture.api.executePurge(plan); assert.equal(accepted.ok, true); assert.equal(accepted.value.status, 'rejected'); assert.equal(executions, 1);
    const history = { schemaVersion: 1, plan: { ...legacy, binding: null, manifest: null }, createdAt: '2026-10-07T10:00:00.000Z', phase: 'done',
      entry: null, authorizationId: null, ownerState: null, result: { action: 'purge', operationId: plan.operationId, sessionId: plan.sessionId,
        entryId: null, status: 'rejected', reason: 'permanent-deletion-unsupported', ownerState: null } };
    fixture.bin.getPurgeOperation = async () => clone(history);
    const receipt = await fixture.api.getPurgeOperation(plan.operationId); assert.equal(receipt.ok, true); assert.deepEqual(receipt.value, history);
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet')); assert.equal(fixture.state.stops.length, 0);
  } finally { await fixture.close(); }
});

test('deletion journal notifications publish a query wakeup without changing the native archive snapshot shape', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture(); let stream;
  try {
    stream = fixture.api.follow(); const iterator = stream[Symbol.asyncIterator]();
    const baseline = (await within(iterator.next(), t.signal)).value;
    const next = iterator.next();
    const operationId = randomUUID();
    const notification = { schemaVersion: 2, plan: { schemaVersion: 2, action: 'purge', operationId, sessionId: 'quiet',
      expectedEntryId: null, binding: null, manifest: null, blockers: [] }, createdAt: '2026-10-07T10:00:00.000Z', phase: 'done',
      entry: null, authorizationId: null, ownerState: null, result: { action: 'purge', operationId, sessionId: 'quiet', entryId: null,
        status: 'rejected', reason: 'permanent-deletion-unsupported', ownerState: null } };
    fixture.ctx.emit('domain/changed', { domain: 'session_bin_purge', table: 'operations', key: operationId, operation: 'put', value: notification });
    const pushed = (await within(next, t.signal)).value;
    assert.deepEqual(pushed, baseline); assert.deepEqual(Object.keys(pushed).sort(), ['entries', 'schemaVersion']);
  } finally { stream?.dispose(); await fixture.close(); }
});

function button(h, label) {
  const node = [...h.document.querySelectorAll('button')].find(node => node.textContent.trim() === label);
  assert(node, label); return node;
}
test('single deletion UI is bilingual, focuses cancel, keeps blockers disabled, and requires native acknowledgement', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  try {
    const title = '用户会话 Alpha';
    await h.flush(() => h.sessions.set({ byId: { quiet: { id: 'quiet', title } } }));
    for (const locale of ['zh', 'en']) {
      await h.language(locale); await h.render('panel'); await h.state({ ...h.baseState, entries: [entry] });
      await h.click(button(h, h.t('permanentDelete'))); assert.deepEqual(h.calls.at(-1), ['preparePurge', entry, title]);
      await h.render('notice'); const plan = planFor();
      await h.state({ purgeConfirmation: { plan, title, acknowledged: false } });
      const dialog = h.document.querySelector('[role="dialog"]'); assert(dialog); assert.equal(dialog.getAttribute('aria-label'), h.t('deleteTitle', { title }));
      const cancel = button(h, h.t('cancelDeletion')); assert(cancel.hasAttribute('data-modal-autofocus'));
      assert.equal(h.document.activeElement, cancel, 'native modal starts at cancellation');
      assert(button(h, h.t('confirmDeletion')).disabled); assert(h.text().includes(h.t('deleteScope')));
      const checkbox = dialog.querySelector('input[type="checkbox"]'); await h.click(checkbox);
      assert.equal(button(h, h.t('confirmDeletion')).disabled, false);
      await h.click(button(h, h.t('cancelDeletion'))); assert.equal(h.calls.at(-1)[0], 'cancelPurge'); assert.equal(h.document.querySelector('[role="dialog"]'), null);
      await h.state({ purgeConfirmation: { plan: { ...plan, blockers: [{ code: 'jsonl/writer-active' }] }, title, acknowledged: true } });
      assert(h.text().includes(h.t('deletionWriter'))); assert(button(h, h.t('confirmDeletion')).disabled);
      await h.click(button(h, h.t('cancelDeletion')));
    }
  } finally { await h.close(); }
});
