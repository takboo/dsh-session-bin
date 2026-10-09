import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createI18nHarness } from './helpers/i18n-harness.mjs';

const entries = [
  { schemaVersion: 2, sessionId: 'named', entryId: '3bc8899d-959b-4c4e-8147-8f8e7aa9d95c' },
  { schemaVersion: 2, sessionId: 'untitled', entryId: '76b7e179-6f89-4b6a-bcf9-c9bb8f7d7da34' },
];
const namedTitle = '设计讨论 Alpha';
const namedWorkspace = '客户工作区 Workspace';
function query(document, selector) { const node = document.querySelector(selector); assert(node, `missing UI element ${selector}`); return node; }
function button(document, text) {
  const candidates = [...document.querySelectorAll('button')].filter(node => node.textContent.trim() === text);
  assert.equal(candidates.length, 1, `expected one button with text ${JSON.stringify(text)}`);
  return candidates[0];
}
function expectText(h, text) { assert(h.text().includes(text), `expected rendered copy ${JSON.stringify(text)} in ${JSON.stringify(h.text())}`); }
function placeholders(text) { return [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort(); }
async function metadata(h) {
  await h.flush(() => { h.sessions.set({ byId: { named: { id: 'named', title: namedTitle }, untitled: { id: 'untitled', title: '' } } });
    h.workspaces.set({ items: [{ workspaceId: 'workspace', title: namedWorkspace, sessionIds: ['named'] }] }); });
}
async function input(h, text) {
  await h.flush(() => {
    const node = query(h.document, 'input:not([type="checkbox"])');
    Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, 'value').set.call(node, text);
    node.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  });
}
function selectNamed(h) { return [...h.document.querySelectorAll('label')].find(node => node.textContent === h.t('select', { title: namedTitle })).querySelector('input'); }

// This tier injects readable UI states into real React DOM and primitives. It
// does not implement Host mutations; real RPC/factory checks remain separate.
test('balanced bilingual templates render native archive states and accessible labels without fabricated times', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  try {
    assert.deepEqual(Object.keys(h.components.en).sort(), Object.keys(h.components.zh).sort());
    for (const key of Object.keys(h.components.en)) {
      assert(h.components.en[key].trim() && h.components.zh[key].trim(), `${key} has empty copy`);
      assert.deepEqual(placeholders(h.components.en[key]), placeholders(h.components.zh[key]), `${key} changes interpolation fields`);
    }
    assert.equal(h.components.BinMenu, undefined);
    for (const key of ['bin', 'undo', 'originalArchive', 'originalArchiveHint', 'restoredArchived']) assert.equal(h.components.en[key], undefined);
    await metadata(h);
    for (const language of ['zh', 'en']) {
      await h.language(language);
      await h.state({ ...h.baseState, phase: 'loading' });
      expectText(h, h.t('loading')); expectText(h, h.t('description'));
      assert.equal(query(h.document, 'section').getAttribute('aria-label'), h.t('title'));
      assert.equal(query(h.document, 'input:not([type="checkbox"])').getAttribute('aria-label'), h.t('search'));
      assert.equal(query(h.document, 'input:not([type="checkbox"])').getAttribute('placeholder'), h.t('search'));
      assert.equal(query(h.document, 'select').getAttribute('aria-label'), h.t('workspace'));
      await h.state({ phase: 'ready' });
      expectText(h, h.t('empty')); expectText(h, h.t('emptyHint')); expectText(h, h.t('count', { count: 0 }));
      await h.state({ entries: [entries[0]] }); expectText(h, h.t('countOne', { count: 1 }));
      await h.state({ entries }); expectText(h, h.t('count', { count: 2 }));
      expectText(h, h.t('unnamed')); expectText(h, h.t('ungrouped')); expectText(h, namedTitle); expectText(h, namedWorkspace);
      assert.equal(query(h.document, 'section ul').getAttribute('aria-label'), h.t('entries'));
      assert.equal(h.document.querySelector('time'), null);
      assert(!h.text().includes(entries[0].entryId), 'observation identity is not user-facing archive metadata');
      assert.equal(h.document.querySelectorAll('section li button').length, 4);
      for (const row of h.document.querySelectorAll('section li')) assert.deepEqual([...row.querySelectorAll('button')].map(node => node.textContent), [h.t('unarchive'), h.t('permanentDelete')]);
      await h.click(selectNamed(h)); expectText(h, h.t('selected', { count: 1 }));
      button(h.document, h.t('unarchiveSelected')); await h.click(button(h.document, h.t('clearSelection')));
      const selectAll = [...h.document.querySelectorAll('label')].find(node => node.textContent === h.t('selectAll'));
      assert(selectAll?.querySelector('input[type="checkbox"]'));
      await input(h, 'does-not-match-anything'); expectText(h, h.t('noMatches')); expectText(h, h.t('noMatchesHint'));
      await input(h, '');
    }
  } finally { await h.close(); }
});

test('stable translator switches preserve user metadata, fixed identity selection, and search draft', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  try {
    await metadata(h); await h.language('zh'); await h.state({ entries });
    const t = h.t; await h.click(selectNamed(h));
    for (const language of ['en', 'zh', 'en']) {
      await h.language(language);
      assert.equal(h.locale.bind(h.components.NS), t);
      expectText(h, h.t('title')); expectText(h, h.t('unnamed')); expectText(h, h.t('ungrouped')); expectText(h, h.t('selected', { count: 1 }));
      expectText(h, namedTitle); expectText(h, namedWorkspace);
      assert.equal(h.sessions.getSnapshot().byId.named.title, namedTitle);
      assert.equal(h.workspaces.getSnapshot().items[0].title, namedWorkspace);
      assert(selectNamed(h).checked);
      assert.equal(h.document.querySelector('time'), null);
    }
    await input(h, 'Alpha');
    for (const language of ['zh', 'en', 'zh']) {
      await h.language(language);
      assert.equal(query(h.document, 'input:not([type="checkbox"])').value, 'Alpha');
      assert.equal(h.document.querySelectorAll('section ul[aria-label] > li').length, 1);
      expectText(h, h.t('selected', { count: 1 })); expectText(h, namedTitle);
    }
    await h.flush(() => h.workspaces.set({ items: [{ workspaceId: 'workspace', title: '', sessionIds: ['named'] }] }));
    for (const language of ['en', 'zh']) {
      await h.language(language); expectText(h, h.t('unnamedWorkspace'));
      assert.equal(query(h.document, 'select').options[1].textContent, h.t('unnamedWorkspace'));
      assert.equal(query(h.document, 'select').options[2].textContent, h.t('ungrouped'));
    }
    await h.state({ entries: [{ ...entries[0], entryId: '05d88b7b-fc36-40c3-a366-d53554a7d1a3' }] });
    assert(!selectNamed(h).checked, 'a replaced observation identity exits selection');
    assert.equal(h.document.querySelector('footer'), null);
  } finally { await h.close(); }
});

test('visible errors, pending receipts and query-only legacy copy are localized in both languages', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  const reasons = [
    ['session-active', 'active'], ['session-not-found', 'missing'], ['not-archived', 'notArchived'], ['legacy-pending', 'legacyPending'],
    ['pending-result', 'pendingResult'], ['pending-operation', 'pendingResult'], ['pending-deletion', 'pendingDeletion'], ['connection-failed', 'connectionFailed'],
    ['purge-cache-capacity', 'purgeCacheCapacity'],
    ['state-changed', 'stateChanged'], ['archive-changed', 'stateChanged'], ['entry-changed', 'stateChanged'],
    ['interrupted', 'stateChanged'], ['future-unknown-reason', 'operationFailed'], [null, 'operationFailed'],
  ];
  try {
    await metadata(h);
    for (const language of ['zh', 'en']) {
      await h.language(language);
      for (const [reason, key] of reasons) {
        assert.equal(h.components.reasonText(reason, h.t), h.t(key));
        await h.state({ ...h.baseState, phase: 'error', error: reason ?? 'future-unknown-reason' });
        assert.equal(query(h.document, '[role="alert"] span').textContent, h.t(key));
        if (reason === 'purge-cache-capacity') assert.equal([...h.document.querySelectorAll('button')].filter(node => node.textContent.trim() === h.t('retry')).length, 0);
        else button(h.document, h.t('retry'));
      }
      await h.click(button(h.document, h.t('retry'))); assert.equal(h.calls.at(-1)[0], 'refresh');
      await h.state({ ...h.baseState, pending: [{ schemaVersion: 2, sessionId: 'named', operationId: 'pending-one' }] });
      assert.equal(query(h.document, '[role="status"] span').textContent, h.t('pendingOne', { count: 1 }));
      await h.click(button(h.document, h.t('checkPending'))); assert.equal(h.calls.at(-1)[0], 'checkPending');
      await h.state({ pending: [{ schemaVersion: 2, sessionId: 'named' }, { schemaVersion: 2, sessionId: 'untitled' }] });
      assert.equal(query(h.document, '[role="status"] span').textContent, h.t('pending', { count: 2 }));
      await h.state({ error: 'pending-result' }); button(h.document, h.t('checkPending'));
      await h.state({ error: 'legacy-pending', entries: [entries[0]], pending: [{ schemaVersion: 1, sessionId: 'named' }] });
      expectText(h, h.t('legacyPending')); assert.equal(button(h.document, h.t('unarchive')).disabled, false);
      await h.click(button(h.document, h.t('checkResults'))); assert.equal(h.calls.at(-1)[0], 'checkPending');
      await h.state({ pending: [{ schemaVersion: 2, sessionId: 'named' }] });
      assert.equal(button(h.document, h.t('unarchive')).disabled, true, 'unknown v2 mutation still blocks another action');
      await h.state({ ...h.baseState, entries, results: [
        { sessionId: 'named', entryId: entries[0].entryId, status: 'success', reason: null },
        { sessionId: 'untitled', entryId: entries[1].entryId, status: 'conflict', reason: 'entry-changed' },
      ] });
      const results = [...h.document.querySelectorAll('ul')].find(node => node.getAttribute('aria-label') === h.t('results'));
      assert.equal(results.getAttribute('aria-live'), 'polite');
      assert(results.textContent.includes(h.t('resultSuccess')) && results.textContent.includes(h.t('stateChanged')));
    }
  } finally { await h.close(); }
});

test('single and selected unarchive actions and live Toast copy follow active language without duplicate Undo', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  try {
    await metadata(h);
    for (const language of ['zh', 'en']) {
      await h.language(language); await h.state({ ...h.baseState, entries: [entries[0]] }); await h.render('panel');
      await h.click(button(h.document, h.t('unarchive'))); assert.deepEqual(h.calls.at(-1), ['unarchive', entries[0]]);
      await h.click(selectNamed(h)); await h.click(button(h.document, h.t('unarchiveSelected')));
      assert.deepEqual(h.calls.at(-1), ['unarchiveMany', [entries[0]]]);
      assert.equal(h.document.querySelector('footer'), null, 'successful fixed targets exit selection');
      await h.render('notice');
      for (const [sequence, kind, reason, key] of [[1, 'unarchived', null, 'unarchived'], [2, 'failed', 'session-active', 'active']]) {
        await h.state({ notice: { sequence, kind, sessionId: 'named', entryId: entries[0].entryId, reason } });
        expectText(h, h.t(key)); assert.equal(h.document.querySelector('button'), null);
      }
    }
    await h.state({ notice: { sequence: 90, kind: 'unarchived', sessionId: 'named', entryId: entries[0].entryId, reason: null } });
    for (const language of ['zh', 'en', 'zh']) { await h.language(language); expectText(h, h.t('unarchived')); assert.equal(h.document.querySelector('button'), null); }
  } finally { await h.close(); }
});

test('composition keeps the search draft, applies it on completion, and Escape preserves composing input', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  try {
    await metadata(h); await h.state({ entries });
    const node = query(h.document, 'input:not([type="checkbox"])');
    await h.flush(() => node.dispatchEvent(new h.dom.window.CompositionEvent('compositionstart', { bubbles: true })));
    await input(h, '设计');
    assert.equal(h.document.querySelectorAll('section li').length, 2, 'composition does not filter intermediate text');
    await h.flush(() => node.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
    assert.equal(node.value, '设计');
    await h.language('zh'); assert.equal(node.value, '设计');
    await h.flush(() => node.dispatchEvent(new h.dom.window.CompositionEvent('compositionend', { bubbles: true })));
    assert.equal(h.document.querySelectorAll('section li').length, 1);
    await h.flush(() => node.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(node.value, ''); assert.equal(h.document.querySelectorAll('section li').length, 2);
  } finally { await h.close(); }
});
