import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import { SessionBin, acquireBinLease } from '../dist/index.js';
import { createScratch, openFixture } from './helpers/fixture.mjs';

function latch() {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  return {
    entered: entered.promise,
    release: released.resolve,
    async pause() { entered.resolve(); await released.promise; },
  };
}

// Bind untouched methods to their actual owner; wrappers only control the
// externally visible persistence/activity boundary under test.
function override(target, methods) {
  return new Proxy(target, {
    get(owner, key) {
      if (Object.hasOwn(methods, key)) return methods[key];
      const value = Reflect.get(owner, key, owner);
      return typeof value === 'function' ? value.bind(owner) : value;
    },
  });
}

async function enteredBeforeAbort(gate, signal) {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try { await Promise.race([gate.entered, aborted.promise]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

// Observe rejection immediately so a deliberately failed durable boundary
// cannot produce an unhandled rejection while the test drives native events.
function outcome(promise) {
  return promise.then(value => ({ value }), error => ({ error }));
}

async function nativeABA(fixture, rawId) {
  await fixture.ctx.workspaceRegistry.unarchiveSession(SessionId(rawId));
  await fixture.ctx.workspaceRegistry.archiveSession(SessionId(rawId));
}

test('a durable conflict invalidates ownership across failed deletion and a complete Host reopen',
  { timeout: 15000 }, async t => {
    const root = await createScratch('conflict-cleanup-');
    const gate = latch();
    const deletionFailure = new Error('injected entry deletion failure after durable conflict');
    let fixture;
    let opened;
    let execution;
    let failDelete = true;
    try {
      fixture = await openFixture(root, { seed: true, plugin: false });
      opened = await fixture.openModule({ storeWrapper(store) {
        return override(store, {
          async putEntry(entry) {
            await gate.pause();
            await store.putEntry(entry);
          },
          async deleteEntry(sessionId) {
            if (sessionId === 'quiet' && failDelete) {
              failDelete = false;
              throw deletionFailure;
            }
            await store.deleteEntry(sessionId);
          },
        });
      } });
      const plan = await opened.module.prepare({ action: 'bin', sessionId: 'quiet' });
      execution = outcome(opened.module.execute(plan));
      await enteredBeforeAbort(gate, t.signal);
      assert.equal(opened.store.operation(plan.operationId).phase, 'applied');
      await nativeABA(fixture, 'quiet');
      gate.release();
      assert.equal((await execution).error, deletionFailure);

      // The cleanup failure must actually leave the entry behind; otherwise a
      // reopen test would not exercise the disputed durable ordering.
      const receipt = opened.store.operation(plan.operationId);
      assert.equal(receipt.phase, 'done');
      assert.equal(receipt.result.status, 'conflict');
      assert.equal(receipt.result.reason, 'archive-changed');
      assert.equal(receipt.ownershipInvalidated, true);
      assert.equal(opened.store.entry('quiet').entryId, receipt.entry.entryId);
      assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));

      await opened.close();
      opened = undefined;
      await fixture.close();
      fixture = undefined;
      fixture = await openFixture(root, { plugin: false });
      opened = await fixture.openModule();
      assert.deepEqual(await opened.module.list(), []);
      assert.deepEqual(await opened.module.execute(plan), receipt.result);
      assert.equal((await opened.module.getOperation(plan.operationId)).ownershipInvalidated, true);
      assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'),
        'metadata recovery must preserve the later native archive');
    } finally {
      gate.release();
      await execution;
      await opened?.close();
      await fixture?.close();
    }
  });

for (const rearchive of [false, true]) {
  test(`activity admission preserves external ${rearchive ? 'unarchive/rearchive' : 'unarchive'} without calling native archive`,
    { timeout: 15000 }, async t => {
      const root = await createScratch('activity-invalidation-');
      const gate = latch();
      const operationId = `activity-${rearchive ? 'aba' : 'undo'}`;
      const archiveCalls = [];
      let fixture;
      let opened;
      let execution;
      let gated = false;
      try {
        fixture = await openFixture(root, { seed: true, plugin: false });
        await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
        opened = await fixture.openModule({ nativeWrapper(native) {
          return override(native, {
            async activity(sessionId) {
              // Gate the admission belonging to an already durable intent,
              // rather than depending on how many preparation checks exist.
              if (!gated && sessionId === 'quiet'
                && opened?.store.operation(operationId)?.phase === 'intent') {
                gated = true;
                await gate.pause();
              }
              return native.activity(sessionId);
            },
            async archive(sessionId) {
              archiveCalls.push(sessionId);
              await native.archive(sessionId);
            },
          });
        } });
        const plan = await opened.module.prepare({ action: 'bin', sessionId: 'quiet', operationId });
        assert.equal(plan.expected.archived, true);
        assert.deepEqual(plan.blockers, []);
        execution = outcome(opened.module.execute(plan));
        await enteredBeforeAbort(gate, t.signal);
        await fixture.ctx.workspaceRegistry.unarchiveSession(SessionId('quiet'));
        if (rearchive) await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
        gate.release();
        const settled = await execution;
        assert.equal(settled.error, undefined);
        assert.equal(settled.value.status, 'conflict');
        assert.equal(settled.value.reason, 'state-changed');
        assert.deepEqual(archiveCalls, [], 'known invalidation must stop the native call itself');
        assert.equal(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'), rearchive);
        assert.deepEqual(await opened.module.list(), []);
        assert.equal((await opened.module.getOperation(operationId)).ownershipInvalidated, true);
      } finally {
        gate.release();
        await execution;
        await opened?.close();
        await fixture?.close();
      }
    });
}

test('close keeps observing external archive changes until admitted metadata work has drained',
  { timeout: 15000 }, async t => {
    const root = await createScratch('closing-invalidation-');
    const gate = latch();
    let fixture;
    let opened;
    let execution;
    let closing;
    try {
      fixture = await openFixture(root, { seed: true, plugin: false });
      opened = await fixture.openModule({ storeWrapper(store) {
        return override(store, {
          async putEntry(entry) {
            await gate.pause();
            await store.putEntry(entry);
          },
        });
      } });
      const plan = await opened.module.prepare({ action: 'bin', sessionId: 'quiet' });
      execution = outcome(opened.module.execute(plan));
      await enteredBeforeAbort(gate, t.signal);
      closing = opened.close();
      await assert.rejects(opened.module.list(), error => error.code === 'bin/closed');
      await nativeABA(fixture, 'quiet');
      gate.release();
      const settled = await execution;
      assert.equal(settled.error, undefined);
      assert.equal(settled.value.status, 'conflict');
      assert.equal(settled.value.reason, 'archive-changed');
      await closing;
      closing = undefined;
      opened = undefined;
      assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
      await fixture.close();
      fixture = undefined;

      fixture = await openFixture(root, { plugin: false });
      opened = await fixture.openModule();
      assert.deepEqual(await opened.module.list(), []);
      const receipt = await opened.module.getOperation(plan.operationId);
      assert.equal(receipt.phase, 'done');
      assert.equal(receipt.result.status, 'conflict');
      assert.equal(receipt.ownershipInvalidated, true);
      assert(fixture.ctx.workspaceRegistry.archivedSessionIds.includes('quiet'));
    } finally {
      gate.release();
      await execution;
      await closing;
      await opened?.close();
      await fixture?.close();
    }
  });

test('disposing a real Cordis plugin during initialization releases its acquired lease',
  { timeout: 15000 }, async t => {
    const root = await createScratch('cancel-initialization-');
    const coordinationDirectory = join(root, 'coordination');
    const constructed = Promise.withResolvers();
    let fixture;
    let fiber;
    let release;
    try {
      fixture = await openFixture(root, { plugin: false });
      // Cordis calls inherited initialization in the same synchronous stack
      // after construction. This marker resumes the test at its first async
      // filesystem boundary, without overriding any production method.
      class ConstructionObservedBin extends SessionBin {
        constructor(ctx, config) {
          super(ctx, config);
          constructed.resolve();
        }
      }
      fiber = fixture.ctx.plugin(ConstructionObservedBin, { coordinationDirectory });
      const startup = outcome(fiber.await());
      await enteredBeforeAbort({ entered: constructed.promise }, t.signal);
      await fiber.dispose();
      const settled = await startup;
      assert.equal(settled.error?.code, 'INACTIVE_EFFECT',
        'the plugin must be cancelled before cleanup registration, rather than initialize normally');
      assert.equal(fixture.ctx.get('sessionBin'), undefined);
      assert((await lstat(join(coordinationDirectory, 'writer.lock'))).isFile(),
        'cancelled initialization must have reached acquisition, not skipped it');
      release = await acquireBinLease(coordinationDirectory);
      await release();
      release = undefined;
    } finally {
      await release?.();
      await fiber?.dispose();
      await fixture?.close();
    }
  });
