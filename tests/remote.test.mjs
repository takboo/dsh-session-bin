import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as product from '../dist/index.js';
import { snapshotSchema, sessionBinRemoteContribution } from '../dist/remote.js';
import { openRemoteFixture, within } from './helpers/remote-fixture.mjs';

function success(result) {
  assert.equal(result.ok, true, result.error?.message);
  return result.value;
}

test('public strict Typert descriptors perform real Client RPC and preserve operation receipts', { timeout: 15000 }, async () => {
  const fixture = await openRemoteFixture();
  try {
    const initial = success(await fixture.api.list());
    assert.deepEqual(initial, []);
    const plan = success(await fixture.api.prepare({ action: 'bin', sessionId: 'quiet' }));
    const moved = success(await fixture.api.execute(plan));
    assert.equal(moved.status, 'success');
    assert.equal(success(await fixture.api.list())[0].sessionId, 'quiet');
    assert.deepEqual(success(await fixture.api.execute(plan)), moved);
    const recorded = success(await fixture.api.getOperation(plan.operationId));
    assert.equal(recorded.phase, 'done');
    assert.deepEqual(recorded.result, moved);
    assert.equal(success(await fixture.api.getOperation('unknown-operation')), null);
    const restore = success(await fixture.api.prepare({ action: 'restore', sessionId: 'quiet' }));
    assert.equal(success(await fixture.api.execute(restore)).status, 'success');
    assert.deepEqual(success(await fixture.api.list()), []);
    assert.deepEqual(success(await fixture.api.execute(plan)), moved);
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    assert(fixture.requests.length > 5);
    for (const request of fixture.requests) {
      assert.equal(request.body.type, 'client-request');
      assert.equal(typeof request.body.rpcId, 'string');
      assert(request.path.startsWith('/api/sessionBin/'));
      assert.equal(request.body.method, request.path.slice('/api/'.length));
    }
    assert.equal(fixture.ctx.sessions.list().length, 0);
  } finally { await fixture.close(); }
});

test('Host exact argument and strict codec boundaries reject malformed RPC without native changes', { timeout: 15000 }, async () => {
  const fixture = await openRemoteFixture();
  try {
    const invalid = await fixture.api.prepare({ action: 'purge', sessionId: 'quiet' });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'gateway/input-invalid');
    const extra = await fixture.client.connection.rpc.call('/api', 'sessionBin/prepare', {
      args: { request: { action: 'bin', sessionId: 'quiet' }, arbitrary: 'field' },
    });
    assert.equal(extra.ok, false);
    assert.equal(extra.error.code, 'gateway/arguments-invalid');
    const missing = await fixture.client.connection.rpc.call('/api', 'sessionBin/prepare', { args: {} });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'gateway/arguments-invalid');
    const unknownPath = await fixture.api.prepare({ action: 'bin', sessionId: 'quiet', path: '/arbitrary' });
    assert.equal(unknownPath.ok, false);
    assert.equal(unknownPath.error.code, 'gateway/input-invalid');
    const emptyIdentity = await fixture.api.getOperation('');
    assert.equal(emptyIdentity.ok, false);
    assert.equal(emptyIdentity.error.code, 'gateway/input-invalid');
    assert.deepEqual(await fixture.bin.list(), []);
    assert.deepEqual(fixture.ctx.workspaceRegistry.archivedSessionIds, []);
    assert.equal(fixture.state.stops.length, 0);
  } finally { await fixture.close(); }
});

test('Remote separates Host operation refusal from transport errors and preserves declared bin failure codes', { timeout: 15000 }, async () => {
  const fixture = await openRemoteFixture();
  try {
    const plan = success(await fixture.api.prepare({ action: 'bin', sessionId: 'quiet' }));
    assert.equal(success(await fixture.api.execute(plan)).status, 'success');
    const reused = await fixture.api.execute({ ...plan, sessionId: 'sibling' });
    assert.equal(reused.ok, false);
    assert.equal(reused.error.code, 'bin/operation-id-reused');
    fixture.state.activity.set('active', ['turn', 'job']);
    const active = success(await fixture.api.prepare({ action: 'bin', sessionId: 'active' }));
    const refused = success(await fixture.api.execute(active));
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.reason, 'session-active');
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('active'));
    assert.deepEqual(fixture.state.stops, []);
  } finally { await fixture.close(); }
});

test('follow publishes a baseline then coalesced metadata replacements, and observes external restore', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  const signal = new AbortController();
  let stream;
  try {
    stream = fixture.api.follow(signal.signal);
    const iterator = stream[Symbol.asyncIterator]();
    const baseline = await within(iterator.next(), t.signal);
    assert.equal(baseline.done, false);
    assert.deepEqual(snapshotSchema.parse(baseline.value).entries, []);
    const next = iterator.next();
    const plan = success(await fixture.api.prepare({ action: 'bin', sessionId: 'quiet' }));
    assert.equal(success(await fixture.api.execute(plan)).status, 'success');
    const changed = await within(next, t.signal);
    assert.equal(changed.done, false);
    assert.deepEqual(snapshotSchema.parse(changed.value).entries.map(entry => entry.sessionId), ['quiet']);
    const external = iterator.next();
    await fixture.ctx.workspaceRegistry.unarchiveSession(SessionId('quiet'));
    const restored = await within(external, t.signal);
    assert.deepEqual(snapshotSchema.parse(restored.value).entries, []);
    const stopping = iterator.next();
    signal.abort();
    await assert.rejects(within(stopping, t.signal), error => error.code === 'gateway/cancelled');
    stream.dispose();
    stream = fixture.api.follow();
    const replacement = stream[Symbol.asyncIterator]();
    assert.deepEqual(snapshotSchema.parse((await within(replacement.next(), t.signal)).value).entries, []);
    const disposedRead = replacement.next();
    stream.dispose();
    assert.equal((await within(disposedRead, t.signal)).done, true);
  } finally { signal.abort(); stream?.dispose(); await fixture.close(); }
});

test('Client contribution withdrawal removes methods and fences retained handles', { timeout: 15000 }, async () => {
  const fixture = await openRemoteFixture();
  try {
    const retained = fixture.api.prepare;
    await fixture.unmount();
    assert.equal(fixture.client.remote.sessionBin, undefined);
    const withdrawn = await retained({ action: 'bin', sessionId: 'quiet' });
    assert.equal(withdrawn.ok, false);
    assert.equal(withdrawn.error.code, 'gateway/internal');
    assert.deepEqual(await fixture.bin.list(), []);
    const remount = await fixture.client.remote.$mount(sessionBinRemoteContribution);
    assert.deepEqual(success(await fixture.client.remote.sessionBin.list()), []);
    await remount();
  } finally { await fixture.close(); }
});

test('Host unload closes paused follow iterators and withdraws strict definitions before reactivation', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  let stream;
  try {
    const plan = success(await fixture.api.prepare({ action: 'bin', sessionId: 'quiet' }));
    assert.equal(success(await fixture.api.execute(plan)).status, 'success');
    stream = fixture.api.follow();
    const iterator = stream[Symbol.asyncIterator]();
    assert.equal((await within(iterator.next(), t.signal)).value.entries.length, 1);
    await fixture.binFiber.dispose();
    assert.equal(fixture.ctx.typert.local.get('sessionBin/list'), undefined);
    assert.equal(fixture.ctx.typert.local.hasSeen('sessionBin/list'), true);
    assert.equal((await within(iterator.next(), t.signal)).done, true);
    const unavailable = await fixture.api.list();
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.error.code, 'gateway/definition-unavailable');
    await fixture.mount(product, { coordinationDirectory: join(fixture.root, 'coordination') });
    assert.equal(success(await fixture.api.list()).length, 1);
    const restored = success(await fixture.api.prepare({ action: 'restore', sessionId: 'quiet' }));
    assert.equal(success(await fixture.api.execute(restored)).status, 'success');
    assert.deepEqual(success(await fixture.api.list()), []);
  } finally { stream?.dispose(); await fixture.close(); }
});

test('return wakes a pending Host follow read and removes its listener without aborting the caller signal', { timeout: 15000 }, async t => {
  const fixture = await openRemoteFixture();
  const signal = new AbortController();
  let iterator;
  const count = () => fixture.ctx.events.dispatch('emit', ['domain/changed', {
    domain: 'session_bin', table: 'entries', key: 'fixture', operation: 'deleted',
  }]).length;
  try {
    const baselineCount = count();
    iterator = fixture.ctx.get('sessionBinRemote').follow(signal.signal)[Symbol.asyncIterator]();
    assert.equal((await within(iterator.next(), t.signal)).done, false);
    assert.equal(count(), baselineCount + 1);
    const pending = iterator.next();
    const returning = iterator.return();
    const settled = await within(Promise.all([pending, returning]), t.signal);
    assert(settled.every(item => item.done));
    assert.equal(signal.signal.aborted, false);
    assert.equal(count(), baselineCount);
  } finally { signal.abort(); await iterator?.return(); await fixture.close(); }
});

test('a real Client plugin consumes its mounted namespace through an injected child lifetime', { timeout: 15000 }, async () => {
  const fixture = await openRemoteFixture();
  let fiber;
  let forbidden;
  let result;
  let childDisposed = 0;
  let activation = 0;
  const feature = {
    name: 'session-bin-test-client-fiber',
    inject: ['remote'],
    async apply(ctx) {
      await ctx.remote.$mount(sessionBinRemoteContribution);
      try { void ctx.remote.sessionBin; }
      catch (error) { forbidden = error; }
      await ctx.inject(['remote', 'remote.sessionBin'], async child => {
        activation += 1;
        result = await child.remote.sessionBin.list();
        child.effect(() => () => { childDisposed += 1; }, 'remote-test-child.dispose');
      });
    },
  };
  try {
    await fixture.unmount();
    fiber = fixture.client.plugin(feature);
    await fiber;
    assert.match(forbidden?.message ?? '', /cannot get property "remote\.sessionBin" without inject/);
    assert.deepEqual(success(result), []);
    assert.equal(activation, 1);
    await fiber.dispose();
    fiber = undefined;
    assert.equal(childDisposed, 1);
    assert.equal(fixture.client.remote.sessionBin, undefined);
    forbidden = undefined;
    fiber = fixture.client.plugin(feature);
    await fiber;
    assert.match(forbidden?.message ?? '', /cannot get property "remote\.sessionBin" without inject/);
    assert.deepEqual(success(result), []);
    assert.equal(activation, 2);
    await fiber.dispose();
    fiber = undefined;
    assert.equal(childDisposed, 2);
    assert.equal(fixture.client.remote.sessionBin, undefined);
  } finally { await fiber?.dispose(); await fixture.close(); }
});

test('an already aborted Remote execute cannot enter the Host mutation queue', { timeout: 15000 }, async () => {
  const fixture = await openRemoteFixture();
  try {
    const plan = success(await fixture.api.prepare({ action: 'bin', sessionId: 'quiet' }));
    const cancelled = new AbortController();
    cancelled.abort();
    const result = await fixture.api.execute(plan, cancelled.signal);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'gateway/cancelled');
    assert.deepEqual(await fixture.bin.list(), []);
    assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    assert.equal(await fixture.bin.getOperation(plan.operationId), undefined);
  } finally { await fixture.close(); }
});
