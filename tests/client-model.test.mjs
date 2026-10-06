import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SessionBinClientModel } from '../dist/client-model.js';
import { openRemoteFixture, within } from './helpers/remote-fixture.mjs';

function override(target, methods) {
  return new Proxy(target, { get(owner, key) {
    if (Object.hasOwn(methods, key)) return methods[key];
    const item = Reflect.get(owner, key, owner);
    return typeof item === 'function' ? item.bind(owner) : item;
  } });
}
function cache() {
  let plans = [];
  return { load: () => structuredClone(plans), save: next => { plans = structuredClone(next); } };
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

// The model uses the real SDK Client RPC/stream face and the real Host catalog.
// Wrappers inject only lost replies or absent delivery at the transport boundary.
test('Client model consumes real baselines and restores prior archives without losing its feedback', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  const model = new SessionBinClientModel(fixture.api, streamFactory(fixture));
  try {
    await ready(model, t.signal);
    assert.deepEqual(model.getSnapshot().entries, []);
    await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
    assert.equal((await model.move('quiet')).status, 'success');
    await waitFor(model, state => state.entries.length === 1, t.signal);
    assert.equal(model.getSnapshot().entries[0].wasArchived, true);
    const entry = model.getSnapshot().entries[0];
    assert.equal((await model.restore(entry)).status, 'success');
    await waitFor(model, state => state.entries.length === 0, t.signal);
    assert.equal(model.getSnapshot().notice.wasArchived, true);
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
  } finally { await model.dispose(); await fixture.close(); }
});

test('a lost execution reply survives page reload and is confirmed without replaying the mutation', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  const saved = cache();
  let blocked = true;
  let executions = 0;
  const api = override(fixture.api, {
    async execute(plan, signal) { executions += 1; await fixture.api.execute(plan, signal); throw new Error('lost reply'); },
    async getOperation(id, signal) { if (blocked) throw new Error('temporarily offline'); return fixture.api.getOperation(id, signal); },
  });
  let model = new SessionBinClientModel(api, streamFactory(fixture), saved);
  try {
    await ready(model, t.signal);
    assert.equal((await model.move('quiet')).status, 'pending');
    assert.equal(saved.load().length, 1);
    const identity = saved.load()[0].operationId;
    assert.equal((await fixture.bin.getOperation(identity)).phase, 'done');
    assert.equal((await model.move('quiet')).status, 'pending');
    assert.equal(executions, 1);
    await model.dispose();
    blocked = false;
    model = new SessionBinClientModel(api, streamFactory(fixture), saved);
    await ready(model, t.signal);
    await waitFor(model, state => state.pending.length === 0, t.signal);
    assert.equal(saved.load().length, 0);
    assert.equal(executions, 1);
    assert.equal(model.getSnapshot().notice.kind, 'moved');
    assert.equal((await fixture.bin.list()).length, 1);
  } finally { await model.dispose(); await fixture.close(); }
});

test('a missing receipt requires explicit retry and resends the same prepared identity', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  const saved = cache();
  const attempts = [];
  const api = override(fixture.api, {
    async execute(plan, signal) {
      attempts.push(plan.operationId);
      if (attempts.length === 1) throw new Error('request never reached Host');
      return fixture.api.execute(plan, signal);
    },
  });
  const model = new SessionBinClientModel(api, streamFactory(fixture), saved);
  try {
    await ready(model, t.signal);
    assert.equal((await model.move('quiet')).status, 'pending');
    assert.equal((await fixture.bin.list()).length, 0);
    await model.checkPending(false);
    assert.equal(attempts.length, 1, 'baseline receipt checks must not submit work');
    await model.checkPending(true);
    assert.equal(model.getSnapshot().pending.length, 0);
    assert.deepEqual(attempts, [attempts[0], attempts[0]]);
    assert.equal((await fixture.bin.list()).length, 1);
    assert.equal((await fixture.bin.operations()).length, 1);
  } finally { await model.dispose(); await fixture.close(); }
});

test('batch restore freezes its selected entry identities and excludes later arrivals', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  let added = false;
  const api = override(fixture.api, {
    async execute(plan, signal) {
      const result = await fixture.api.execute(plan, signal);
      if (plan.action === 'restore' && !added) {
        added = true;
        const newcomer = await fixture.bin.prepare({ action: 'bin', sessionId: 'race' });
        assert.equal((await fixture.bin.execute(newcomer)).status, 'success');
      }
      return result;
    },
  });
  const model = new SessionBinClientModel(api, streamFactory(fixture));
  try {
    await ready(model, t.signal);
    await model.move('quiet'); await model.move('sibling');
    await waitFor(model, state => state.entries.length === 2, t.signal);
    const selected = [...model.getSnapshot().entries];
    const results = await model.restoreMany(selected);
    assert.equal(results.length, 2);
    assert(results.every(item => item.status === 'success'));
    await waitFor(model, state => state.entries.length === 1, t.signal);
    assert.equal(model.getSnapshot().entries[0].sessionId, 'race');
    assert.deepEqual((await fixture.bin.list()).map(entry => entry.sessionId), ['race']);
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('sibling'));
  } finally { await model.dispose(); await fixture.close(); }
});

test('Undo for an old entry cannot restore a newly binned generation of the same conversation', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  let executions = 0;
  const api = override(fixture.api, { async execute(plan, signal) { executions += 1; return fixture.api.execute(plan, signal); } });
  const model = new SessionBinClientModel(api, streamFactory(fixture));
  try {
    await ready(model, t.signal);
    await model.move('quiet');
    await waitFor(model, state => state.entries.length === 1, t.signal);
    const old = model.getSnapshot().entries[0];
    await fixture.ctx.workspaceRegistry.unarchiveSession(SessionId('quiet'));
    await fixture.bin.reconcile();
    assert.equal((await fixture.bin.execute(await fixture.bin.prepare({ action: 'bin', sessionId: 'quiet' }))).status, 'success');
    await waitFor(model, state => state.entries[0]?.entryId !== old.entryId && state.entries.length === 1, t.signal);
    assert.equal((await model.restore(old)).reason, 'entry-changed');
    assert.equal(executions, 1, 'stale Undo must not call Host execute');
    assert.equal((await fixture.bin.list()).length, 1);
    assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
  } finally { await model.dispose(); await fixture.close(); }
});

test('Client model disposal ends the real subscription and leaves no catalog listener', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  const listenerCount = () => fixture.ctx.events.dispatch('emit', ['domain/changed']).length;
  const baseline = listenerCount();
  const model = new SessionBinClientModel(fixture.api, streamFactory(fixture));
  try {
    await ready(model, t.signal);
    assert(listenerCount() > baseline);
    await model.dispose();
    assert.equal(listenerCount(), baseline);
    const snapshot = model.getSnapshot();
    await fixture.bin.execute(await fixture.bin.prepare({ action: 'bin', sessionId: 'quiet' }));
    assert.equal(model.getSnapshot(), snapshot, 'a disposed model cannot publish a late result');
  } finally { await model.dispose(); await fixture.close(); }
});

test('a catalog push before the execution reply does not settle an in-flight operation twice', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const api = override(fixture.api, {
    async execute(plan, signal) {
      const result = await fixture.api.execute(plan, signal);
      entered.resolve();
      await release.promise;
      return result;
    },
  });
  const model = new SessionBinClientModel(api, streamFactory(fixture));
  let execution;
  try {
    await ready(model, t.signal);
    execution = model.move('quiet');
    await within(entered.promise, t.signal);
    await waitFor(model, state => state.entries.length === 1, t.signal);
    await model.checkPending(false);
    assert.equal(model.getSnapshot().pending.length, 1);
    assert.equal(model.getSnapshot().notice, null);
    assert(model.getSnapshot().busy.includes('quiet'));
    release.resolve();
    assert.equal((await execution).status, 'success');
    assert.equal(model.getSnapshot().notice.sequence, 1);
    await model.checkPending(false);
    assert.equal(model.getSnapshot().notice.sequence, 1);
    assert.equal(model.getSnapshot().pending.length, 0);
  } finally { release.resolve(); await execution; await model.dispose(); await fixture.close(); }
});
