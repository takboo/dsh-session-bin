import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import { DomainBinStore } from '../dist/index.js';
import { SessionBinClientModel, browserPendingCache } from '../dist/client-model.js';
import { openRemoteFixture, within } from './helpers/remote-fixture.mjs';

function override(target, methods) {
  return new Proxy(target, { get(owner, key) {
    if (Object.hasOwn(methods, key)) return methods[key];
    const item = Reflect.get(owner, key, owner);
    return typeof item === 'function' ? item.bind(owner) : item;
  } });
}
function cache(initial = []) {
  let plans = initial;
  return { load: () => structuredClone(plans), save: next => { plans = structuredClone(next); } };
}
function storage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return { getItem: key => items.get(key) ?? null, setItem: (key, item) => { items.set(key, item); }, removeItem: key => { items.delete(key); } };
}
function streamFactory(fixture) {
  return () => fixture.client.remote.$stream({
    name: 'session-bin.model-test', open: signal => fixture.api.follow(signal),
    ended: () => new Error('Snapshot generation ended.'),
  });
}
async function waitFor(model, predicate, signal) {
  if (predicate(model.getSnapshot())) return;
  const ready = Promise.withResolvers();
  const off = model.subscribe(() => { if (predicate(model.getSnapshot())) ready.resolve(); });
  try { if (predicate(model.getSnapshot())) return; await within(ready.promise, signal); }
  finally { off(); }
}
async function ready(model, signal) { await model.refresh(); await waitFor(model, state => state.phase === 'ready', signal); }
async function archive(fixture, model, sessionId, signal) {
  await fixture.ctx.workspaceRegistry.archiveSession(SessionId(sessionId));
  await waitFor(model, state => state.entries.some(entry => entry.sessionId === sessionId), signal);
  return model.getSnapshot().entries.find(entry => entry.sessionId === sessionId);
}
const legacyPlan = action => ({ schemaVersion: 1, operationId: `old-${action}`, action, sessionId: action === 'bin' ? 'quiet' : 'sibling',
  expected: { archived: action === 'restore', entryId: action === 'restore' ? '05d88b7b-fc36-40c3-a366-d53554a7d1a3' : null }, blockers: [] });

// Real SDK Client RPC/stream and native WorkspaceRegistry. Wrappers inject lost
// replies or failed delivery at the transport boundary, never fake native state.
test('Client model lists native archives and unarchives them without prior Bin membership', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  const model = new SessionBinClientModel(fixture.api, streamFactory(fixture));
  try {
    await ready(model, t.signal); assert.deepEqual(model.getSnapshot().entries, []);
    const entry = await archive(fixture, model, 'quiet', t.signal);
    assert.deepEqual(Object.keys(entry).sort(), ['entryId', 'schemaVersion', 'sessionId']);
    assert.equal(entry.schemaVersion, 2); assert.equal(model.move, undefined); assert.equal(model.restore, undefined);
    assert.equal((await model.unarchive(entry)).status, 'success');
    await waitFor(model, state => state.entries.length === 0, t.signal);
    assert.equal(model.getSnapshot().notice.kind, 'unarchived');
    assert.equal(Object.hasOwn(model.getSnapshot().notice, 'wasArchived'), false);
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
  } finally { await model.dispose(); await fixture.close(); }
});

test('a lost unarchive reply survives page reload and is confirmed without replay', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture(); const saved = cache(); let blocked = true; let executions = 0;
  const api = override(fixture.api, {
    async execute(plan, signal) { executions += 1; await fixture.api.execute(plan, signal); throw new Error('lost reply'); },
    async getOperation(id, signal) { if (blocked) throw new Error('temporarily offline'); return fixture.api.getOperation(id, signal); },
  });
  let model = new SessionBinClientModel(api, streamFactory(fixture), saved);
  try {
    await ready(model, t.signal); const entry = await archive(fixture, model, 'quiet', t.signal);
    assert.equal((await model.unarchive(entry)).status, 'pending'); assert.equal(saved.load().length, 1);
    const identity = saved.load()[0].operationId; assert.equal((await fixture.bin.getOperation(identity)).phase, 'done');
    assert.equal((await model.unarchive(entry)).status, 'pending'); assert.equal(executions, 1);
    await model.dispose(); blocked = false; model = new SessionBinClientModel(api, streamFactory(fixture), saved);
    await ready(model, t.signal); await waitFor(model, state => state.pending.length === 0, t.signal);
    assert.equal(saved.load().length, 0); assert.equal(executions, 1);
    assert.equal(model.getSnapshot().notice.kind, 'unarchived'); assert.equal((await fixture.bin.list()).length, 0);
  } finally { await model.dispose(); await fixture.close(); }
});

test('a missing v2 receipt requires explicit retry with the same prepared identity', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture(); const saved = cache(); const attempts = [];
  const api = override(fixture.api, { async execute(plan, signal) {
    attempts.push(plan.operationId); if (attempts.length === 1) throw new Error('request never reached Host');
    return fixture.api.execute(plan, signal);
  } });
  const model = new SessionBinClientModel(api, streamFactory(fixture), saved);
  try {
    await ready(model, t.signal); const entry = await archive(fixture, model, 'quiet', t.signal);
    assert.equal((await model.unarchive(entry)).status, 'pending'); assert.equal((await fixture.bin.list()).length, 1);
    await model.checkPending(false); assert.equal(attempts.length, 1, 'baseline receipt checks cannot submit work');
    await model.checkPending(true); assert.equal(model.getSnapshot().pending.length, 0);
    assert.deepEqual(attempts, [attempts[0], attempts[0]]); assert.equal((await fixture.bin.list()).length, 0);
    assert.equal((await fixture.bin.getOperation(attempts[0])).result.status, 'success');
  } finally { await model.dispose(); await fixture.close(); }
});

test('batch unarchive freezes selected entry identities and excludes later native archives', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture(); let added = false;
  const api = override(fixture.api, { async execute(plan, signal) {
    const result = await fixture.api.execute(plan, signal);
    if (!added) { added = true; await fixture.ctx.workspaceRegistry.archiveSession(SessionId('race')); }
    return result;
  } });
  const model = new SessionBinClientModel(api, streamFactory(fixture));
  try {
    await ready(model, t.signal); await archive(fixture, model, 'quiet', t.signal); await archive(fixture, model, 'sibling', t.signal);
    const selected = [...model.getSnapshot().entries]; const results = await model.unarchiveMany(selected);
    assert.equal(results.length, 2); assert(results.every(item => item.status === 'success'));
    await waitFor(model, state => state.entries.length === 1 && state.entries[0].sessionId === 'race', t.signal);
    assert.deepEqual((await fixture.bin.list()).map(entry => entry.sessionId), ['race']);
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('sibling'));
  } finally { await model.dispose(); await fixture.close(); }
});

test('an old selection cannot unarchive a later observed archive identity for the same conversation', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture(); let executions = 0;
  const api = override(fixture.api, { async execute(plan, signal) { executions += 1; return fixture.api.execute(plan, signal); } });
  const model = new SessionBinClientModel(api, streamFactory(fixture));
  try {
    await ready(model, t.signal); const old = await archive(fixture, model, 'quiet', t.signal);
    await fixture.ctx.workspaceRegistry.unarchiveSession(SessionId('quiet')); await fixture.bin.list();
    await waitFor(model, state => state.entries.length === 0, t.signal);
    const current = await archive(fixture, model, 'quiet', t.signal); assert.notEqual(current.entryId, old.entryId);
    assert.equal((await model.unarchive(old)).reason, 'entry-changed'); assert.equal(executions, 0, 'stale selection cannot call execute');
    assert.equal((await fixture.bin.list()).length, 1); assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
  } finally { await model.dispose(); await fixture.close(); }
});

test('Client disposal ends the real subscription and prevents late publications', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  const listenerCount = () => fixture.ctx.events.dispatch('emit', ['domain/changed']).length;
  const baseline = listenerCount(); const model = new SessionBinClientModel(fixture.api, streamFactory(fixture));
  try {
    await ready(model, t.signal); assert(listenerCount() > baseline);
    await model.dispose(); assert.equal(listenerCount(), baseline);
    const snapshot = model.getSnapshot(); await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
    assert.equal(model.getSnapshot(), snapshot);
  } finally { await model.dispose(); await fixture.close(); }
});

test('an archive push before the execution reply cannot settle in-flight work twice', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture(); const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const api = override(fixture.api, { async execute(plan, signal) {
    const result = await fixture.api.execute(plan, signal); entered.resolve(); await release.promise; return result;
  } });
  const model = new SessionBinClientModel(api, streamFactory(fixture)); let execution;
  try {
    await ready(model, t.signal); const entry = await archive(fixture, model, 'quiet', t.signal);
    execution = model.unarchive(entry); await within(entered.promise, t.signal);
    await waitFor(model, state => state.entries.length === 0, t.signal); await model.checkPending(false);
    assert.equal(model.getSnapshot().pending.length, 1); assert.equal(model.getSnapshot().notice, null); assert(model.getSnapshot().busy.includes('quiet'));
    release.resolve(); assert.equal((await execution).status, 'success'); assert.equal(model.getSnapshot().notice.sequence, 1);
    await model.checkPending(false); assert.equal(model.getSnapshot().notice.sequence, 1); assert.equal(model.getSnapshot().pending.length, 0);
  } finally { release.resolve(); await execution; await model.dispose(); await fixture.close(); }
});

test('browser v1 pending bin and restore migrate to v2, remain queryable, and never replay even on explicit retry', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture(); const plans = [legacyPlan('bin'), legacyPlan('restore')];
  const local = storage({ 'dsh-session-bin.pending.v1': JSON.stringify(plans) }); const queries = []; let executions = 0; let preparations = 0;
  const api = override(fixture.api, {
    async getOperation(id, signal) { queries.push(id); return fixture.api.getOperation(id, signal); },
    async execute() { executions += 1; throw new Error('legacy execution is forbidden'); },
    async prepare() { preparations += 1; throw new Error('legacy preparation is forbidden'); },
  });
  let model = new SessionBinClientModel(api, streamFactory(fixture), browserPendingCache(local));
  try {
    assert.equal(local.getItem('dsh-session-bin.pending.v1'), null);
    assert.deepEqual(JSON.parse(local.getItem('dsh-session-bin.pending.v2')), plans);
    await ready(model, t.signal); await waitFor(model, state => state.error === 'legacy-pending', t.signal);
    await model.checkPending(false); await model.checkPending(true);
    assert.equal(model.getSnapshot().pending.length, 2); assert.equal(model.getSnapshot().error, 'legacy-pending');
    assert(queries.includes('old-bin') && queries.includes('old-restore')); assert.equal(executions, 0); assert.equal(preparations, 0);
    await model.dispose(); model = new SessionBinClientModel(api, streamFactory(fixture), browserPendingCache(local));
    await ready(model, t.signal); await model.checkPending(true);
    assert.equal(model.getSnapshot().pending.length, 2); assert.equal(executions, 0); assert.equal(preparations, 0);
    assert.deepEqual(fixture.ctx.workspaceRegistry.archivedSessionIds, []);
  } finally { await model.dispose(); await fixture.close(); }
});

test('known legacy historical receipts are consumed without claiming an unarchive or changing native state', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  const plan = legacyPlan('bin');
  const entry = { schemaVersion: 1, sessionId: 'quiet', entryId: '05d88b7b-fc36-40c3-a366-d53554a7d1a3',
    operationId: plan.operationId, binnedAt: '2026-10-06T09:47:00.000Z', workspaceIdAtBin: null, wasArchived: false };
  const oldStore = new DomainBinStore(fixture.ctx.storageDomain.get('session_bin'));
  await oldStore.putOperation({ schemaVersion: 1, plan, createdAt: entry.binnedAt, phase: 'done', ownershipInvalidated: false, entry,
    result: { operationId: plan.operationId, action: 'bin', sessionId: 'quiet', status: 'success', reason: null, entryId: entry.entryId } });
  await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
  const saved = cache([plan]); let executions = 0;
  const api = override(fixture.api, { async execute() { executions += 1; throw new Error('no historical replay'); } });
  const model = new SessionBinClientModel(api, streamFactory(fixture), saved);
  try {
    await ready(model, t.signal); await waitFor(model, state => state.pending.length === 0, t.signal);
    assert.equal(saved.load().length, 0); assert.equal(executions, 0); assert.equal(model.getSnapshot().notice, null);
    assert.deepEqual(model.getSnapshot().results, []); assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    assert.equal(model.getSnapshot().entries.length, 1);
  } finally { await model.dispose(); await fixture.close(); }
});

test('blocked cache migration preserves legacy records and malformed items do not erase valid query identities', () => {
  const plan = legacyPlan('restore'); const malformed = { schemaVersion: 1, action: 'restore' };
  const local = storage({ 'dsh-session-bin.pending.v1': JSON.stringify([malformed, plan]), 'dsh-session-bin.pending.v2': '{invalid' });
  const blocked = { ...local, setItem() { throw new Error('storage withheld'); } };
  assert.deepEqual(browserPendingCache(blocked).load(), [plan]);
  assert(local.getItem('dsh-session-bin.pending.v1'), 'failed v2 write preserves the legacy cache');
  assert.deepEqual(browserPendingCache(local).load(), [plan]);
  assert.equal(local.getItem('dsh-session-bin.pending.v1'), null);
  assert.deepEqual(JSON.parse(local.getItem('dsh-session-bin.pending.v2')), [plan]);
});


test('unknown legacy query-only pending does not block a new explicit unarchive of the observed native target', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture(); const old = legacyPlan('bin'); const executions = []; const preparations = [];
  const api = override(fixture.api, {
    async execute(plan, signal) { executions.push(plan); return fixture.api.execute(plan, signal); },
    async prepare(request, signal) { preparations.push(request); return fixture.api.prepare(request, signal); },
  });
  const model = new SessionBinClientModel(api, streamFactory(fixture), cache([old]));
  try {
    await ready(model, t.signal); await waitFor(model, state => state.error === 'legacy-pending', t.signal);
    const entry = await archive(fixture, model, 'quiet', t.signal);
    assert.equal((await model.unarchive(entry)).status, 'success');
    await model.checkPending(true);
    assert.equal(executions.length, 1); assert.equal(executions[0].schemaVersion, 2); assert.equal(executions[0].action, 'unarchive');
    assert.equal(preparations.length, 1); assert.equal(preparations[0].action, 'unarchive');
    assert.notEqual(executions[0].operationId, old.operationId);
    assert.deepEqual(model.getSnapshot().pending, [old]);
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
  } finally { await model.dispose(); await fixture.close(); }
});
