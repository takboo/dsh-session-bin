import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionBin, acquireBinLease, retirementDomainSpec } from '../dist/index.js';
import { createScratch, openFixture } from './helpers/fixture.mjs';

function latch() {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  return { entered: entered.promise, release: released.resolve,
    async pause() { entered.resolve(); await released.promise; } };
}
function includes(error, text) {
  return Boolean(error && (String(error.message).includes(text) || includes(error.cause, text)
    || error.errors?.some(child => includes(child, text))));
}
async function assertLeaseReleased(root) {
  const release = await acquireBinLease(join(root, 'coordination'));
  await release();
}

// All faults are at public backend/consumer interfaces on isolated data. No
// private native session, index or resource fields are modified.
test('two-journal initialization failure closes the first domain and releases the lease', { timeout: 15000 }, async t => {
  const root = await createScratch('purge-open-failure-');
  t.diagnostic(root);
  const fixture = await openFixture(root, { seed: true, plugin: false });
  const backend = fixture.ctx.storage.backend.get('json');
  const originalOpen = backend.kv.open.bind(backend.kv);
  backend.kv.open = async descriptor => {
    if (descriptor.name === retirementDomainSpec.name) throw new Error('injected second journal open failure');
    return originalOpen(descriptor);
  };
  let fiber;
  try {
    fiber = fixture.ctx.plugin(SessionBin, { coordinationDirectory: join(root, 'coordination') });
    await assert.rejects(fiber.await(), error => includes(error, 'injected second journal open failure'));
    await fiber.dispose();
    assert.equal(fixture.ctx.storageDomain.get('session_bin'), undefined);
    assert.equal(fixture.ctx.storageDomain.get('session_bin_purge'), undefined);
    await assertLeaseReleased(root);
  } finally { backend.kv.open = originalOpen; await fiber?.dispose(); await fixture.close(); }
});

test('cancellation during the second domain open holds lease until initialization and both domains settle', { timeout: 15000 }, async t => {
  const root = await createScratch('purge-open-cancel-');
  t.diagnostic(root);
  const fixture = await openFixture(root, { seed: true, plugin: false });
  const backend = fixture.ctx.storage.backend.get('json');
  const originalOpen = backend.kv.open.bind(backend.kv);
  const gate = latch();
  backend.kv.open = async descriptor => {
    const unit = await originalOpen(descriptor);
    if (descriptor.name === retirementDomainSpec.name) await gate.pause();
    return unit;
  };
  let fiber;
  let disposing;
  try {
    fiber = fixture.ctx.plugin(SessionBin, { coordinationDirectory: join(root, 'coordination') });
    const startup = fiber.await().then(() => ({ error: null }), error => ({ error }));
    await gate.entered;
    disposing = fiber.dispose();
    await assert.rejects(acquireBinLease(join(root, 'coordination')), error => error.code === 'bin/lease-unavailable');
    gate.release();
    assert.equal((await startup).error?.code, 'INACTIVE_EFFECT');
    await disposing;
    assert.equal(fixture.ctx.storageDomain.get('session_bin'), undefined);
    assert.equal(fixture.ctx.storageDomain.get('session_bin_purge'), undefined);
    assert.equal(fixture.ctx.get('sessionBin'), undefined);
    await assertLeaseReleased(root);
  } finally {
    gate.release(); backend.kv.open = originalOpen;
    await disposing; await fiber?.dispose(); await fixture.close();
  }
});

test('unit close acknowledgement failure still attempts both journals and releases the drained lease', { timeout: 15000 }, async t => {
  const root = await createScratch('purge-close-failure-');
  t.diagnostic(root);
  const fixture = await openFixture(root, { seed: true, plugin: false });
  const backend = fixture.ctx.storage.backend.get('json');
  const originalOpen = backend.kv.open.bind(backend.kv);
  const closeAttempts = [];
  backend.kv.open = async descriptor => {
    const unit = await originalOpen(descriptor);
    if (!['session_bin', 'session_bin_purge'].includes(descriptor.name)) return unit;
    return new Proxy(unit, { get(target, key) {
      if (key === 'close') return async () => {
        closeAttempts.push(descriptor.name);
        await target.close();
        if (descriptor.name === 'session_bin_purge') throw new Error('injected closed-unit acknowledgement failure');
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  let fiber;
  try {
    fiber = fixture.ctx.plugin(SessionBin, { coordinationDirectory: join(root, 'coordination') });
    await fiber;
    assert.equal(fiber.error, undefined);
    const purgeDomain = fixture.ctx.storageDomain.get('session_bin_purge');
    await fiber.dispose();
    assert(closeAttempts.includes('session_bin_purge'));
    assert(closeAttempts.includes('session_bin'));
    assert.equal(fixture.ctx.storageDomain.get('session_bin'), undefined);
    assert.equal(fixture.ctx.get('sessionBin'), undefined);
    await assert.rejects(purgeDomain.table('operations').put('must-not-write', {}), error => error.code === 'closed');
    await assertLeaseReleased(root);
  } finally {
    backend.kv.open = originalOpen;
    await fiber?.dispose();
    // Domain.close caches its failed acknowledgement; this Context must be
    // retired even though all writes are refused and the actual unit closed.
    try { await fixture.close(); }
    catch (error) { assert(includes(error, 'injected closed-unit acknowledgement failure')); }
  }
});

test('schema-valid ownership corruption during fixture construction closes both domains and lease', { timeout: 15000 }, async t => {
  const root = await createScratch('purge-constructor-failure-');
  t.diagnostic(root);
  const fixture = await openFixture(root, { seed: true, plugin: false });
  let opened;
  try {
    opened = await fixture.openModule();
    assert.equal((await opened.module.execute(await opened.module.prepare({ action: 'bin', sessionId: 'quiet' }))).status, 'success');
    const entry = opened.store.entry('quiet');
    await opened.store.putEntry({ ...entry, entryId: randomUUID() });
    await opened.close(); opened = undefined;
    await assert.rejects(fixture.openModule(), /Bin entry has no matching ownership journal/);
    assert.equal(fixture.ctx.storageDomain.get('session_bin'), undefined);
    assert.equal(fixture.ctx.storageDomain.get('session_bin_purge'), undefined);
    await assertLeaseReleased(root);
  } finally { await opened?.close(); await fixture.close(); }
});
