import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SessionBinClientModel } from '../dist/client-model.js';
import { createScratch, transcript } from './helpers/fixture.mjs';
import { openNativeDeletionFixture } from './helpers/native-deletion-fixture.mjs';

const ok = value => ({ ok: true, value });
async function openModel(fixture) {
  const api = {
    preparePurge: async request => ok(await fixture.module.preparePurge(request)),
    executePurge: async plan => ok(await fixture.module.executePurge(plan)),
    getPurgeOperation: async id => ok((await fixture.module.getPurgeOperation(id)) ?? null),
    purgeOperations: async () => ok(await fixture.module.purgeOperations()),
    prepare: async request => ok(await fixture.module.prepare(request)),
    execute: async plan => ok(await fixture.module.execute(plan)),
    getOperation: async id => ok(await fixture.module.getOperation(id)),
  };
  const stream = () => {
    const stopped = Promise.withResolvers(); const abort = new AbortController();
    return { dispose: async () => { abort.abort(); stopped.resolve(); }, async *[Symbol.asyncIterator]() {
      yield { value: { schemaVersion: 2, entries: await fixture.module.list() }, signal: abort.signal, accept() {} };
      await stopped.promise;
    } };
  };
  const model = new SessionBinClientModel(api, stream);
  await model.refresh();
  if (model.getSnapshot().phase !== 'ready') {
    const ready = Promise.withResolvers();
    const off = model.subscribe(() => { if (model.getSnapshot().phase === 'ready') ready.resolve(); });
    try { await ready.promise; } finally { off(); }
  }
  return model;
}

for (const compression of ['none', 'zstd']) test(`fixed Client batch and clear use real SDK erasure and preserve an unselected transcript (${compression})`, { timeout: 30000 }, async t => {
  const root = await createScratch(`native-batch-host-${compression}-`); t.diagnostic(root);
  let fixture = await openNativeDeletionFixture(root, { seed: true, compression });
  let model;
  try {
    for (const id of ['sibling', 'native-only']) await fixture.ctx.workspaceRegistry.archiveSession(SessionId(id));
    const survivor = await transcript(fixture, 'race');
    const nativeOnly = await transcript(fixture, 'native-only');
    model = await openModel(fixture);
    const entries = model.getSnapshot().entries;
    const selected = entries.filter(row => row.sessionId === 'quiet' || row.sessionId === 'sibling');
    assert.equal(selected.length, 2);
    const prepared = await model.preparePurgeBatch({ kind: 'selection', entryIds: selected.map(row => row.entryId) });
    assert.equal(prepared.frozenCount, 2); assert(prepared.items.every(item => item.state === 'ready'));
    model.acknowledgePurgeBatch(true);
    const batch = await model.runPurgeBatch();
    assert.equal(batch.phase, 'done'); assert(batch.items.every(item => item.outcome.status === 'success'));
    for (const item of batch.items) assert.equal((await fixture.module.getPurgeOperation(item.plan.operationId)).ownerState.phase, 'done');
    assert.deepEqual(await transcript(fixture, 'native-only'), nativeOnly);
    await model.refresh();
    if (model.getSnapshot().phase !== 'ready') {
      const ready = Promise.withResolvers();
      const off = model.subscribe(() => { if (model.getSnapshot().phase === 'ready') ready.resolve(); });
      try { await ready.promise; } finally { off(); }
    }
    model.dismissPurgeBatch();
    const clear = await model.preparePurgeBatch({ kind: 'all-archived' });
    assert.equal(clear.frozenCount, 1); assert.equal(clear.items[0].target.sessionId, 'native-only');
    model.acknowledgePurgeBatch(true);
    assert.equal((await model.runPurgeBatch()).phase, 'done');
    await model.dispose(); model = null;
    await fixture.close(); fixture = await openNativeDeletionFixture(root, { compression });
    for (const id of ['quiet', 'sibling', 'native-only']) {
      assert.equal(await fixture.ctx.sessionPersistence.stat(SessionId(id)), undefined);
      assert(!fixture.ctx.workspaceRegistry.archivedSessionIds.includes(id));
      assert(!fixture.ctx.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(id)));
      assert.equal(fixture.ctx.get('sessionProjectionCache').requireTable().get(id), undefined);
      assert.equal(fixture.ctx.get('sessionQuery')._db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get(id), undefined);
    }
    assert.deepEqual(await transcript(fixture, 'race'), survivor);
  } finally { await model?.dispose(); await fixture.close(); }
});

test('a real durable owner fence pauses the Client batch without admitting its later target', { timeout: 30000 }, async () => {
  const fixture = await openNativeDeletionFixture(await createScratch('native-batch-host-fenced-'), { seed: true, ownerOptions: { canAdvance: () => false } });
  let model;
  try {
    await fixture.ctx.workspaceRegistry.archiveSession(SessionId('sibling'));
    const before = await transcript(fixture, 'sibling');
    model = await openModel(fixture);
    const prepared = await model.preparePurgeBatch({ kind: 'all-archived' }); assert.equal(prepared.frozenCount, 2);
    model.acknowledgePurgeBatch(true);
    const batch = await model.runPurgeBatch(); assert.equal(batch.phase, 'paused');
    assert.equal(batch.items[0].outcome.status, 'pending-recovery');
    assert.equal(await fixture.module.getPurgeOperation(batch.items[1].plan.operationId), undefined);
    assert.deepEqual(await transcript(fixture, 'sibling'), before);
    fixture.nativeOwner.coordinator.options.canAdvance = () => true;
    assert.equal((await model.retryPurge(batch.items[0].plan.operationId)).status, 'success');
    assert.equal(await fixture.module.getPurgeOperation(batch.items[1].plan.operationId), undefined, 'Checking the first result does not execute the later target.');
    assert.equal((await model.runPurgeBatch()).phase, 'done');
  } finally { await model?.dispose(); await fixture.close(); }
});
