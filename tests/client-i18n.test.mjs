import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createI18nHarness } from './helpers/i18n-harness.mjs';

const entries = [
  { schemaVersion: 1, sessionId: 'named', entryId: '3bc8899d-959b-4c4e-8147-8f8e7aa9d95c', operationId: 'op-named', binnedAt: '2026-10-06T09:47:00.000Z', workspaceIdAtBin: 'workspace', wasArchived: false },
  { schemaVersion: 1, sessionId: 'untitled', entryId: '76b7e179-6f89-4b6a-bcf9-c9bb8f7d7da34', operationId: 'op-untitled', binnedAt: '2026-10-05T08:30:00.000Z', workspaceIdAtBin: null, wasArchived: true },
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

// State/readable injection is intentionally a UI-copy tier. Real Host/RPC and
// actual factory tests remain separate; no language test implements fake mutations.
test('balanced bilingual templates render loading, empty, no-match, counts, rows and accessible labels', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  try {
    assert.deepEqual(Object.keys(h.components.en).sort(), Object.keys(h.components.zh).sort());
    for (const key of Object.keys(h.components.en)) {
      assert(h.components.en[key].trim() && h.components.zh[key].trim(), `${key} has empty copy`);
      assert.deepEqual(placeholders(h.components.en[key]), placeholders(h.components.zh[key]), `${key} changes interpolation fields`);
    }
    await metadata(h);
    for (const language of ['zh', 'en']) {
      await h.language(language);
      await h.state({ ...h.baseState, phase: 'loading' });
      expectText(h, h.t('loading'));
      assert.equal(query(h.document, 'section').getAttribute('aria-label'), h.t('title'));
      assert.equal(query(h.document, 'input:not([type="checkbox"])').getAttribute('aria-label'), h.t('search'));
      assert.equal(query(h.document, 'input:not([type="checkbox"])').getAttribute('placeholder'), h.t('search'));
      assert.equal(query(h.document, 'select').getAttribute('aria-label'), h.t('workspace'));
      await h.state({ phase: 'ready' });
      expectText(h, h.t('empty')); expectText(h, h.t('emptyHint')); expectText(h, h.t('count', { count: 0 }));
      await h.state({ entries: [entries[0]] });
      expectText(h, h.t('countOne', { count: 1 }));
      await h.state({ entries });
      expectText(h, h.t('count', { count: 2 }));
      expectText(h, h.t('unnamed')); expectText(h, h.t('ungrouped'));
      expectText(h, h.t('originalArchive'));
      expectText(h, namedTitle); expectText(h, namedWorkspace);
      const list = query(h.document, 'section ul');
      assert.equal(list.getAttribute('aria-label'), h.t('entries'));
      const time = query(h.document, 'time');
      assert.equal(time.getAttribute('datetime'), entries[0].binnedAt);
      assert.equal(time.textContent, h.formatDate(entries[0].binnedAt));
      const archiveTag = [...h.document.querySelectorAll('span')].find(node => node.textContent === h.t('originalArchive'));
      assert.equal(archiveTag.getAttribute('title'), h.t('originalArchiveHint'));
      const originalRow = [...h.document.querySelectorAll('li')].find(node => node.textContent.includes(h.t('unnamed')));
      assert.equal(originalRow.querySelector('button').getAttribute('title'), h.t('originalArchiveHint'));
      const titleLabel = [...h.document.querySelectorAll('label')].find(node => node.textContent === h.t('select', { title: namedTitle }));
      assert(titleLabel?.querySelector('input[type="checkbox"]'));
      const selectAll = [...h.document.querySelectorAll('label')].find(node => node.textContent === h.t('selectAll'));
      assert(selectAll?.querySelector('input[type="checkbox"]'));
      await h.click(titleLabel.querySelector('input'));
      expectText(h, h.t('selected', { count: 1 }));
      button(h.document, h.t('restoreSelected')); button(h.document, h.t('clearSelection'));
      await h.click(button(h.document, h.t('clearSelection')));
      await h.flush(() => {
        const input = query(h.document, 'input:not([type="checkbox"])');
        Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'does-not-match-anything');
        input.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
      });
      expectText(h, h.t('noMatches')); expectText(h, h.t('noMatchesHint'));
      await h.flush(() => {
        const input = query(h.document, 'input:not([type="checkbox"])');
        Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, 'value').set.call(input, '');
        input.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
      });
    }
  } finally { await h.close(); }
});

test('stable translator language switches update fallbacks and dates without changing user metadata or selection', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  try {
    await metadata(h); await h.language('zh'); await h.state({ entries });
    const t = h.t;
    const checkbox = [...h.document.querySelectorAll('label')].find(node => node.textContent === h.t('select', { title: namedTitle })).querySelector('input');
    await h.click(checkbox);
    for (const language of ['en', 'zh', 'en']) {
      await h.language(language);
      assert.equal(h.locale.bind(h.components.NS), t, 'the real LocaleRuntime keeps t identity stable');
      expectText(h, h.t('title')); expectText(h, h.t('unnamed')); expectText(h, h.t('ungrouped'));
      expectText(h, h.t('selected', { count: 1 }));
      expectText(h, namedTitle); expectText(h, namedWorkspace);
      assert.equal(h.sessions.getSnapshot().byId.named.title, namedTitle);
      assert.equal(h.workspaces.getSnapshot().items[0].title, namedWorkspace);
      const row = [...h.document.querySelectorAll('li')].find(node => node.textContent.includes(namedTitle));
      assert(row.querySelector('input[type="checkbox"]').checked);
      assert.equal(row.querySelector('time').textContent, h.formatDate(entries[0].binnedAt));
    }
    await h.flush(() => {
      const input = query(h.document, 'input:not([type="checkbox"])');
      Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'Alpha');
      input.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    });
    for (const language of ['zh', 'en', 'zh']) {
      await h.language(language);
      assert.equal(query(h.document, 'input:not([type="checkbox"])').value, 'Alpha');
      assert.equal(h.document.querySelectorAll('section ul[aria-label] > li').length, 1);
      expectText(h, h.t('selected', { count: 1 })); expectText(h, namedTitle);
      assert.equal(query(h.document, 'time').textContent, h.formatDate(entries[0].binnedAt));
    }
    await h.flush(() => h.workspaces.set({ items: [{ workspaceId: 'workspace', title: '', sessionIds: ['named'] }] }));
    for (const language of ['en', 'zh']) {
      await h.language(language);
      expectText(h, h.t('unnamedWorkspace'));
      assert.equal(query(h.document, 'select').options[1].textContent, h.t('unnamedWorkspace'));
      assert.equal(query(h.document, 'select').options[2].textContent, h.t('ungrouped'));
    }
  } finally { await h.close(); }
});

test('visible errors, pending singular/plural, retry actions and mixed result lists are localized in both languages', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  const reasons = [
    ['session-active', 'active'], ['session-not-found', 'missing'], ['already-in-bin', 'alreadyInBin'],
    ['not-in-bin', 'notInBin'], ['pending-result', 'pendingResult'], ['pending-operation', 'pendingResult'],
    ['connection-failed', 'connectionFailed'], ['state-changed', 'stateChanged'], ['archive-changed', 'stateChanged'],
    ['entry-changed', 'stateChanged'], ['interrupted', 'stateChanged'], ['future-unknown-reason', 'operationFailed'], [null, 'operationFailed'],
  ];
  try {
    await metadata(h);
    for (const language of ['zh', 'en']) {
      await h.language(language);
      for (const [reason, key] of reasons) {
        assert.equal(h.components.reasonText(reason, h.t), h.t(key));
        await h.state({ ...h.baseState, phase: 'error', error: reason ?? 'future-unknown-reason' });
        assert.equal(query(h.document, '[role="alert"] span').textContent, h.t(key));
        button(h.document, h.t('retry'));
      }
      await h.click(button(h.document, h.t('retry')));
      assert.equal(h.calls.at(-1)[0], 'refresh');
      await h.state({ ...h.baseState, pending: [{ sessionId: 'named', operationId: 'pending-one' }] });
      assert.equal(query(h.document, '[role="status"] span').textContent, h.t('pendingOne', { count: 1 }));
      await h.click(button(h.document, h.t('checkPending')));
      assert.equal(h.calls.at(-1)[0], 'checkPending');
      await h.state({ pending: [{ sessionId: 'named' }, { sessionId: 'untitled' }] });
      assert.equal(query(h.document, '[role="status"] span').textContent, h.t('pending', { count: 2 }));
      await h.state({ error: 'pending-result' });
      assert.equal(query(h.document, '[role="alert"] span').textContent, h.t('pendingResult'));
      button(h.document, h.t('checkPending'));
      await h.state({ ...h.baseState, entries, results: [
        { sessionId: 'named', entryId: entries[0].entryId, status: 'success', reason: null },
        { sessionId: 'untitled', entryId: entries[1].entryId, status: 'conflict', reason: 'entry-changed' },
      ] });
      const results = [...h.document.querySelectorAll('ul')].find(node => node.getAttribute('aria-label') === h.t('results'));
      assert.equal(results.getAttribute('aria-live'), 'polite');
      assert(results.textContent.includes(h.t('resultSuccess')) && results.textContent.includes(h.t('stateChanged')));
      for (const key of ['resultRejected', 'resultConflict', 'resultPending']) {
        assert(h.components.en[key] && h.components.zh[key], 'unused dictionary copy remains balanced but is not claimed as rendered functionality');
      }
    }
  } finally { await h.close(); }
});

test('menu, live Toast copy, Undo and restored archive feedback follow the active language', { timeout: 30000 }, async () => {
  const h = await createI18nHarness();
  try {
    for (const language of ['zh', 'en']) {
      await h.language(language);
      await h.state({ ...h.baseState }); await h.render('menu', { sessionId: 'named' });
      const move = button(h.document, h.t('bin'));
      assert.equal(move.getAttribute('role'), 'menuitem');
      await h.click(move);
      assert.deepEqual(h.calls.slice(-2), [['setMenuOpen', false], ['move', 'named']]);
      await h.state({ entries: [entries[0]] });
      await h.click(button(h.document, h.t('restore')));
      assert.deepEqual(h.calls.at(-1), ['restore', entries[0]]);
      await h.render('notice');
      let sequence = 1;
      for (const [kind, wasArchived, key] of [['moved', false, 'moved'], ['restored', false, 'restored'], ['restored', true, 'restoredArchived'], ['failed', false, 'active']]) {
        await h.state({ notice: { sequence: sequence++, kind, wasArchived, sessionId: 'named', entryId: entries[0].entryId,
          reason: kind === 'failed' ? 'session-active' : null } });
        expectText(h, h.t(key));
        if (kind === 'moved') button(h.document, h.t('undo'));
      }
      await h.state({ notice: { sequence: sequence++, kind: 'moved', wasArchived: false, sessionId: 'named', entryId: entries[0].entryId, reason: null } });
      await h.click(button(h.document, h.t('undo')));
      assert.deepEqual(h.calls.slice(-2), [['dismissNotice'], ['restore', { sessionId: 'named', entryId: entries[0].entryId }]]);
    }
    await h.state({ notice: { sequence: 90, kind: 'moved', wasArchived: false, sessionId: 'named', entryId: entries[0].entryId, reason: null } });
    for (const language of ['zh', 'en', 'zh']) { await h.language(language); expectText(h, h.t('moved')); button(h.document, h.t('undo')); }
  } finally { await h.close(); }
});
