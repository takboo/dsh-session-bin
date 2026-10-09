import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createI18nHarness } from './helpers/i18n-harness.mjs';

const entries = Array.from({ length: 10 }, (_, index) => ({
  schemaVersion: 2,
  sessionId: `session-${index + 1}`,
  entryId: `entry-${index + 1}`,
}));

function button(h, label) {
  const nodes = [...h.document.querySelectorAll('button')].filter(node => node.textContent.trim() === label);
  assert.equal(nodes.length, 1, `expected one button labeled ${JSON.stringify(label)}`);
  return nodes[0];
}

function checkbox(h, label) {
  const owner = [...h.document.querySelectorAll('label')].find(node => node.textContent === label);
  const input = owner?.querySelector('input[type="checkbox"]');
  assert(input, `missing checkbox ${JSON.stringify(label)}`);
  return input;
}

async function setInput(h, value) {
  await h.flush(() => {
    const input = h.document.querySelector('input:not([type="checkbox"])');
    assert(input);
    Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  });
}

function readyPlan(operationId) {
  return { operationId, blockers: [], binding: {}, manifest: {} };
}

function item(index, state, overrides = {}) {
  return {
    target: { sessionId: entries[index].sessionId, entryId: entries[index].entryId, title: `用户标题 ${index + 1} / User title ${index + 1}` },
    state,
    plan: state === 'preparing' ? null
      : state === 'blocked' ? { operationId: `op-${index}`, blockers: [{ code: 'jsonl/writer-active' }], binding: {}, manifest: {} }
        : readyPlan(`op-${index}`),
    reason: state === 'blocked' ? 'jsonl/writer-active' : null,
    outcome: null,
    ...overrides,
  };
}

function batch(phase, items, overrides = {}) {
  return {
    batchId: 'batch-fixed', scope: 'selection', phase, frozenCount: items.length,
    acknowledged: false, stopRequested: false, items,
    resourceCounts: { erase: 5, releaseReference: 3, retainShared: 2, retainCoordination: 4 },
    ...overrides,
  };
}

function createModel(h) {
  const calls = [];
  const model = {
    refresh: async () => { calls.push(['refresh']); },
    unarchive: async entry => { calls.push(['unarchive', entry]); },
    unarchiveMany: async targets => { calls.push(['unarchiveMany', targets]); return []; },
    checkPending: async () => { calls.push(['checkPending']); },
    preparePurge: async (entry, title) => { calls.push(['preparePurge', entry, title]); },
    cancelPurge: () => { calls.push(['cancelPurge']); },
    acknowledgePurge: value => { calls.push(['acknowledgePurge', value]); },
    confirmPurge: async () => { calls.push(['confirmPurge']); },
    checkPurgePending: async () => { calls.push(['checkPurgePending']); },
    retryPurge: async operationId => { calls.push(['retryPurge', operationId]); },
    discardMissingPurge: async operationId => { calls.push(['discardMissingPurge', operationId]); },
    preparePurgeAgain: async (operationId, title) => { calls.push(['preparePurgeAgain', operationId, title]); },
    dismissNotice: () => { calls.push(['dismissNotice']); },
    preparePurgeBatch: async (scope, titles) => { calls.push(['preparePurgeBatch', scope, titles]); },
    acknowledgePurgeBatch: acknowledged => {
      calls.push(['acknowledgePurgeBatch', acknowledged]);
      const state = h.bin.getSnapshot();
      if (state.purgeBatch) h.bin.set({ ...state, purgeBatch: { ...state.purgeBatch, acknowledged } });
    },
    runPurgeBatch: async () => { calls.push(['runPurgeBatch']); },
    stopPurgeBatch: () => { calls.push(['stopPurgeBatch']); },
    dismissPurgeBatch: () => { calls.push(['dismissPurgeBatch']); },
  };
  return { calls, model };
}

async function installMetadata(h) {
  const byId = Object.fromEntries(entries.map((entry, index) => [entry.sessionId, {
    id: entry.sessionId,
    title: index < 2 ? `Visible ${index + 1}` : `Hidden ${index + 1}`,
  }]));
  await h.flush(() => h.sessions.set({ byId }));
}

const cleanState = h => ({ ...h.baseState, purgeBatch: null, purgeCacheBlocked: false });

test('selection and clear-all prepare distinct frozen scopes while filtering only changes visible rows', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  try {
    const { calls, model } = createModel(h);
    await installMetadata(h);
    await h.language('en');
    await h.render('panel', { model });
    await h.state({ ...cleanState(h), entries });
    await setInput(h, 'Visible');
    assert.equal(h.document.querySelectorAll('ul[aria-label="Archived conversations"] > li').length, 2);
    assert.equal(button(h, h.t('clearAllArchived', { count: 10 })).disabled, false);

    await h.click(checkbox(h, h.t('select', { title: 'Visible 1' })));
    await h.click(checkbox(h, h.t('select', { title: 'Visible 2' })));
    await h.click(button(h, h.t('permanentlyDeleteSelected')));
    const selectedCall = calls.at(-1);
    assert.deepEqual(selectedCall[1], { kind: 'selection', entryIds: ['entry-1', 'entry-2'] });
    assert.equal(Object.keys(selectedCall[2]).length, 10, 'titles remain display metadata for the model-frozen scope');

    await h.click(button(h, h.t('clearAllArchived', { count: 10 })));
    const allCall = calls.at(-1);
    assert.deepEqual(allCall[1], { kind: 'all-archived' });
    assert.equal(Object.keys(allCall[2]).length, 10, 'clear-all receives titles for the complete archive collection');
  } finally { await h.close(); }
});

test('native batch modal focuses cancel, requires acknowledgement, blocks M0, and preserves user titles across locale changes', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  try {
    const { calls, model } = createModel(h);
    const confirming = batch('confirming', [item(0, 'ready'), item(1, 'ready'), item(2, 'blocked')]);
    await h.render('notice', { model });
    await h.language('zh');
    await h.state({ ...cleanState(h), purgeBatch: confirming });

    const dialog = h.document.querySelector('[role="dialog"]');
    assert(dialog);
    assert.equal(dialog.getAttribute('aria-label'), h.t('batchSelectionTitle', { count: 3 }));
    assert(h.text().includes(h.t('batchSummary', { total: 3, executable: 2, blocked: 1 })));
    assert(h.text().includes('用户标题 1 / User title 1'));
    assert(h.text().includes(h.t('deletionWriter')));
    assert(!h.text().includes('Host rejected'));
    for (const key of ['resourceErase', 'resourceReleaseReference', 'resourceRetainShared', 'resourceRetainCoordination', 'batchRetainedCopies']) {
      assert(h.text().includes(h.t(key)));
    }

    const cancel = button(h, h.t('cancelDeletion'));
    assert(cancel.hasAttribute('data-modal-autofocus'));
    assert.equal(h.document.activeElement, cancel);
    assert.equal(button(h, h.t('confirmBatchDeletion')).disabled, true);
    await h.click(checkbox(h, h.t('batchAcknowledge')));
    assert.deepEqual(calls.at(-1), ['acknowledgePurgeBatch', true]);
    assert.equal(button(h, h.t('confirmBatchDeletion')).disabled, false);

    await h.language('en');
    assert(h.text().includes('用户标题 1 / User title 1'), 'locale changes do not translate user titles');
    assert(h.text().includes(h.t('batchSummary', { total: 3, executable: 2, blocked: 1 })));

    const noneExecutable = batch('confirming', [item(0, 'blocked'), item(1, 'blocked')], { acknowledged: true });
    await h.state({ purgeBatch: noneExecutable });
    assert.equal(checkbox(h, h.t('batchAcknowledge')).disabled, true);
    assert.equal(button(h, h.t('confirmBatchDeletion')).disabled, true);

    await h.state({ purgeBatch: batch('preparing', [item(0, 'preparing'), item(1, 'preparing')]) });
    await h.flush(() => h.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(calls.at(-1)[0], 'stopPurgeBatch', 'Escape stops targets that have not started');
  } finally { await h.close(); }
});

test('paused pending work has no discard bypass, stop only marks remaining work, and successful targets leave selection', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  try {
    const { calls, model } = createModel(h);
    await installMetadata(h);
    await h.language('en');
    await h.render('panel', { model });
    await h.state({ ...cleanState(h), entries: entries.slice(0, 2) });
    await h.click(checkbox(h, h.t('select', { title: 'Visible 1' })));
    await h.click(checkbox(h, h.t('select', { title: 'Visible 2' })));

    const first = item(0, 'settled', { outcome: { operationId: 'op-0', sessionId: 'session-1', entryId: 'entry-1', status: 'success', reason: null } });
    const pendingSecond = item(1, 'settled', { outcome: { operationId: 'op-1', sessionId: 'session-2', entryId: 'entry-2', status: 'pending', reason: 'deletion-pending' } });
    const paused = batch('paused', [first, pendingSecond]);
    await h.state({ purgeBatch: paused,
      purgePending: [{ operationId: 'op-1', sessionId: 'session-2', expectedEntryId: 'entry-2' }],
      purgeResults: [pendingSecond.outcome] });

    assert(h.text().includes(h.t('batchPausedDescription')));
    assert(h.text().includes(h.t('selected', { count: 1 })), 'successful target exits selection');
    assert.equal(button(h, h.t('continueBatchDeletion')).disabled, true);
    await h.click(button(h, h.t('continueDeletion')));
    assert.deepEqual(calls.at(-1), ['retryPurge', 'op-1']);

    const missingSecond = item(1, 'settled', { outcome: { ...pendingSecond.outcome, reason: 'deletion-result-missing' } });
    await h.state({ purgeBatch: batch('paused', [first, missingSecond]), purgeResults: [missingSecond.outcome],
      purgeBatchOperationIds: ['op-1'] });
    assert.equal([...h.document.querySelectorAll('button')].some(node => node.textContent.trim() === h.t('discardMissingDeletion')), false,
      'an admitted batch operation cannot be discarded');
    await h.click(button(h, h.t('prepareDeletionAgain')));
    assert.deepEqual(calls.at(-1), ['preparePurgeAgain', 'op-1', 'Visible 2']);
    await h.click(button(h, h.t('stopBatchDeletion')));
    assert.equal(calls.at(-1)[0], 'stopPurgeBatch');

    await h.state({ purgeBatch: null });
    assert.equal([...h.document.querySelectorAll('button')].some(node => node.textContent.trim() === h.t('discardMissingDeletion')), false,
      'dismissed or reloaded batch provenance still removes the discard bypass');

    const resumed = batch('paused', [first, item(1, 'ready')]);
    await h.state({ purgePending: [], purgeResults: [], purgeBatch: resumed });
    const continuationCalls = calls.length;
    for (const phase of ['loading', 'error']) {
      await h.state({ phase });
      assert.equal(button(h, h.t('continueBatchDeletion')).disabled, true);
      await h.click(button(h, h.t('continueBatchDeletion')));
      assert.equal(calls.length, continuationCalls);
    }
    await h.state({ phase: 'ready', purgeCacheBlocked: true });
    assert.equal(button(h, h.t('continueBatchDeletion')).disabled, true);
    await h.state({ purgeCacheBlocked: false });
    assert.equal(button(h, h.t('continueBatchDeletion')).disabled, false);
    await h.click(button(h, h.t('continueBatchDeletion')));
    assert.equal(calls.at(-1)[0], 'runPurgeBatch');

    const failed = item(1, 'settled', { outcome: { operationId: 'op-1', sessionId: 'session-2', entryId: 'entry-2', status: 'conflict', reason: 'state-changed' } });
    await h.state({ purgeBatch: batch('done', [first, failed]) });
    assert(h.text().includes(h.t('selected', { count: 1 })), 'failed target remains selected');
    await h.click(button(h, h.t('dismissBatchDeletion')));
    assert.equal(calls.at(-1)[0], 'dismissPurgeBatch');
  } finally { await h.close(); }
});

test('purge cache capacity copy is bilingual and disables only new deletion actions', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  try {
    const { model } = createModel(h);
    await installMetadata(h);
    await h.render('panel', { model });
    for (const locale of ['zh', 'en']) {
      await h.language(locale);
      await h.state({ ...cleanState(h), entries: entries.slice(0, 2), error: 'purge-cache-capacity', purgeCacheBlocked: true });
      assert(h.text().includes(h.t('purgeCacheCapacity')));
      assert.equal(button(h, h.t('clearAllArchived', { count: 2 })).disabled, true);
      const deleteButtons = [...h.document.querySelectorAll('button')].filter(node => node.textContent.trim() === h.t('permanentDelete'));
      const unarchiveButtons = [...h.document.querySelectorAll('button')].filter(node => node.textContent.trim() === h.t('unarchive'));
      assert.equal(deleteButtons.length, 2); assert(deleteButtons.every(node => node.disabled));
      assert.equal(unarchiveButtons.length, 2); assert(unarchiveButtons.every(node => !node.disabled));
      await h.click(checkbox(h, h.t('select', { title: 'Visible 1' })));
      assert.equal(button(h, h.t('permanentlyDeleteSelected')).disabled, true);
      await h.click(checkbox(h, h.t('select', { title: 'Visible 1' })));
    }
  } finally { await h.close(); }
});

test('batch modal and selection controls have bounded scrolling and narrow wrapping rules', async () => {
  const css = await readFile(new URL('../src/client/panel.module.css', import.meta.url), 'utf8');
  assert.match(css, /\.batchModalBody\s*\{[^}]*max-height:[^;}]+;[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.selectionActions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.batchItems li\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.heading\s*\{[^}]*flex-wrap:\s*wrap/);
});
