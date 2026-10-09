import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeAdmission, NativeAdmissionError } from '../dist/index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('closing admission rejects fresh I/O while draining complete accepted frames and their nested SDK work', { timeout: 5000 }, async () => {
  const admission = new NativeAdmission(); admission.activate();
  const entered = Promise.withResolvers(); const finish = Promise.withResolvers(); const late = Promise.withResolvers();
  const effects = [];
  const accepted = admission.track('quiet', async () => {
    entered.resolve(); await finish.promise;
    await admission.track('quiet', async () => { effects.push('accepted-target'); });
    await admission.trackGlobal(async () => { effects.push('accepted-global'); });
    setImmediate(() => {
      try { Promise.resolve(admission.track('quiet', async () => { effects.push('late'); })).then(() => late.resolve(null), error => late.resolve(error)); }
      catch (error) { late.resolve(error); }
    });
  });
  await entered.promise;
  admission.beginClose();
  assert.throws(() => admission.assertAllowed('new'), NativeAdmissionError);
  assert.throws(() => admission.track('new', async () => { effects.push('fresh-target'); }), NativeAdmissionError);
  await assert.rejects(admission.trackGlobal(async () => { effects.push('fresh-global'); }), NativeAdmissionError);
  let drained = false;
  const closing = admission.drain().then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  finish.resolve(); await accepted; await closing;
  assert.equal(drained, true); assert.deepEqual(effects, ['accepted-target', 'accepted-global']);
  assert(await late.promise instanceof NativeAdmissionError);
  assert.deepEqual(effects, ['accepted-target', 'accepted-global']);
});

test('an accepted target request may finish a nested global scan while a later retirement scope waits for its complete frame', { timeout: 5000 }, async () => {
  const admission = new NativeAdmission(); admission.activate();
  const entered = Promise.withResolvers(); const finish = Promise.withResolvers();
  let read = false;
  const accepted = admission.track('quiet', async () => {
    entered.resolve(); await finish.promise;
    await admission.trackGlobal(async () => { admission.assertAllowed('quiet'); read = true; });
  });
  await entered.promise;
  let acquired = false;
  const acquiring = admission.acquire('quiet').then(release => { acquired = true; return release; });
  await tick(); assert.equal(acquired, false);
  finish.resolve(); await accepted;
  const release = await acquiring;
  try { assert.equal(read, true); assert.equal(acquired, true); }
  finally { release(); }
});

test('a global scan waiting outside a held scope rechecks closing before it can invoke an old original method', { timeout: 5000 }, async () => {
  const admission = new NativeAdmission(); admission.activate();
  const release = await admission.acquire('quiet');
  let executed = false;
  const waiting = admission.trackGlobal(async () => { executed = true; });
  admission.beginClose();
  release();
  await assert.rejects(waiting, NativeAdmissionError);
  await admission.drain(); assert.equal(executed, false);
});
