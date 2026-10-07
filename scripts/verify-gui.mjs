import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const workspace = fileURLToPath(new URL('../', import.meta.url));
const expectedSdk = '0.2.0-rc.2';
const fixtures = [
  { id: 'gui-quiet', title: '待整理的设计讨论', workspace: 'primary' },
  { id: 'gui-sibling', title: '接口实现记录', workspace: 'primary' },
  { id: 'gui-native-only', title: '原生归档保留', workspace: 'primary', archived: true },
  { id: 'gui-prearchived', title: '原先已归档的讨论', workspace: 'secondary', archived: true },
];
const browserLocale = process.env.DSH_GUI_LOCALE ?? 'zh-CN';
assert(['zh-CN', 'en-US'].includes(browserLocale), 'DSH_GUI_LOCALE must be zh-CN or en-US');
const requestedLanguage = browserLocale === 'zh-CN' ? 'zh' : 'en';
const fixtureWorkspaces = { primary: 'GUI 主工作区', secondary: 'GUI 第二工作区' };
// Expectations are independent of the product dictionaries. A run must display
// its selected language, rather than pass by accepting either translation.
const copy = {
  zh: {
    panel: '会话回收站', move: '移入回收站', restore: '恢复', undo: '撤销', search: '搜索回收站',
    workspace: '工作区筛选', restoreSelected: '恢复所选', refresh: '刷新', clearSelection: '取消选择',
    description: '暂时收起会话，需要时再恢复。', allWorkspaces: '所有工作区', ungrouped: '未分组',
    empty: '回收站是空的', emptyHint: '通过会话菜单移入回收站。原生归档仍在原来的视图中。',
    noMatches: '没有匹配的会话', noMatchesHint: '试试其他关键词或工作区。',
    selectAll: '选择当前显示的会话', entries: '回收站中的会话', originalArchive: '原先已归档',
    originalArchiveHint: '恢复后会保留这个会话的归档状态。',
    moved: '会话已移入回收站', restored: '会话已恢复', restoredArchived: '已移出回收站，保留原来的归档状态。',
    count: count => `${count} 个会话`, selected: count => `已选 ${count} 项`, select: title => `选择 ${title}`,
    viewOptions: '视图选项', showArchived: '全部对话（显示已归档）', flat: '单列表',
    preview: '预览版说明', continue: '继续', keySetup: '添加一个 API Key 开始使用', configureLater: '稍后配置',
    settings: '设置', general: '通用设置', settingsClose: '关闭', languageLabel: '中文', htmlLanguage: 'zh-CN',
    plugins: '插件', openDetail: title => `查看 ${title}`,
    packageDescription: '通过原生菜单暂时收起会话，支持元数据搜索、工作区筛选与批量恢复。',
  },
  en: {
    panel: 'Session Bin', move: 'Move to Session Bin', restore: 'Restore', undo: 'Undo', search: 'Search Session Bin',
    workspace: 'Workspace filter', restoreSelected: 'Restore selected', refresh: 'Refresh', clearSelection: 'Clear selection',
    description: 'Keep conversations out of the way and restore them when needed.', allWorkspaces: 'All workspaces', ungrouped: 'Ungrouped',
    empty: 'Session Bin is empty', emptyHint: 'Use a conversation’s menu to move it here. Native archives stay in their original view.',
    noMatches: 'No matching conversations', noMatchesHint: 'Try another search or workspace.',
    selectAll: 'Select visible conversations', entries: 'Conversations in Session Bin', originalArchive: 'Originally archived',
    originalArchiveHint: 'Restoring keeps this conversation archived.',
    moved: 'Conversation moved to Session Bin', restored: 'Conversation restored', restoredArchived: 'Removed from Session Bin; the original archive is preserved.',
    count: count => `${count} ${count === 1 ? 'conversation' : 'conversations'}`,
    selected: count => `${count} selected`, select: title => `Select ${title}`,
    viewOptions: 'View options', showArchived: 'All conversations (show archived)', flat: 'In one list',
    preview: 'Preview Notice', continue: 'Continue', keySetup: 'Add an API key to get started', configureLater: 'Configure later',
    settings: 'Settings', general: 'General', settingsClose: 'Close', languageLabel: 'English', htmlLanguage: 'en',
    plugins: 'Plugins', openDetail: title => `View ${title}`,
    packageDescription: 'Move conversations to a recoverable bin with native menus, metadata search, workspace filters, and batch restore.',
  },
};
let language = requestedLanguage;
let ui = copy[language];
const button = (root, name) => root.getByRole('button', { name, exact: true });
const menuItem = (root, name) => root.getByRole('menuitem', { name, exact: true });
const textbox = (root, name) => root.getByRole('textbox', { name, exact: true });
const text = (root, value) => root.getByText(value, { exact: true });
const children = new Set();
const cancellation = new AbortController();
let browserContext;
let scratch;
let activeHost;

// Readiness URLs are consumed privately. Diagnostics and saved reports must not
// expose the process token, browser cookies, or credentials.
function redact(value) {
  return String(value)
    .replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]')
    .replace(/((?:launchToken|authorization|cookie|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
}
function cleanUrl(url) {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}
function ownsPath(root, target) {
  const rel = relative(root, target);
  assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`), 'GUI scratch must stay in this workspace');
}
function signalChild(child, signal) {
  if (!Number.isInteger(child.pid) || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal); // Every child below owns a fresh group.
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function managedSpawn(command, args, options) {
  cancellation.signal.throwIfAborted();
  const child = spawn(command, args, {
    ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}
function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}
async function stopChild(child) {
  if (!child) return { code: null, signal: null, forced: false };
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode, forced: false };
  }
  const exit = exited(child);
  signalChild(child, 'SIGTERM');
  let timer;
  const result = await Promise.race([
    exit,
    new Promise(resolve => { timer = setTimeout(() => resolve(null), 8000); }),
  ]);
  clearTimeout(timer);
  if (result) return { ...result, forced: false };
  signalChild(child, 'SIGKILL');
  return { ...await exit, forced: true };
}
async function runCommand(command, args, options, label, timeout = 180000) {
  const child = managedSpawn(command, args, options);
  let output = '';
  let errors = '';
  const limit = 1024 * 1024;
  child.stdout.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-limit); });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors = (errors + chunk).slice(-limit); });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stopChild(child).catch(error => { console.error(redact(error.message)); });
  }, timeout);
  try {
    const status = await exited(child);
    if (timedOut || status.code !== 0) {
      throw new Error(`${label} failed (${timedOut ? 'timeout' : `exit ${status.code}, signal ${status.signal}`}):\n${redact(errors || output)}`);
    }
    return { stdout: output, stderr: errors };
  } finally { clearTimeout(timer); await stopChild(child); }
}
async function startHost(cli, environment, cwd, logName) {
  const child = managedSpawn(process.execPath, [cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd, env: environment,
  });
  const host = { child, authenticatedUrl: undefined, cleanUrl: undefined, log: '', logName };
  activeHost = host;
  let partial = '';
  let settled = false;
  const ready = Promise.withResolvers();
  const append = chunk => { host.log = (host.log + redact(chunk)).slice(-1024 * 1024); };
  child.stdout.setEncoding('utf8').on('data', chunk => {
    append(chunk);
    partial += chunk;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) {
      const match = /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/.exec(line);
      if (!match || settled) continue;
      try {
        const url = new URL(match[1]);
        assert.notEqual(url.port, '19387', 'The GUI test must not connect to the current Harness');
        host.authenticatedUrl = url.href;
        host.cleanUrl = cleanUrl(url.href);
        settled = true;
        ready.resolve(host);
      } catch (error) {
        settled = true;
        ready.reject(error);
      }
    }
  });
  child.stderr.setEncoding('utf8').on('data', append);
  child.once('error', error => { if (!settled) { settled = true; ready.reject(error); } });
  child.once('close', (code, signal) => {
    if (!settled) { settled = true; ready.reject(new Error(`Isolated dsh web exited before readiness (${code}, ${signal}):\n${host.log}`)); }
  });
  const timer = setTimeout(() => {
    if (!settled) { settled = true; ready.reject(new Error(`Isolated dsh web did not announce readiness:\n${host.log}`)); }
  }, 60000);
  const onAbort = () => ready.reject(cancellation.signal.reason);
  cancellation.signal.addEventListener('abort', onAbort, { once: true });
  try { return await ready.promise; }
  catch (error) { await stopChild(child); throw error; }
  finally { clearTimeout(timer); cancellation.signal.removeEventListener('abort', onAbort); }
}

async function openSdkFixture(paths, seed = false) {
  const ctx = new Context();
  const mounted = [];
  const mount = async (implementation, config) => {
    const fiber = ctx.plugin(implementation, config);
    mounted.push(fiber);
    await fiber;
  };
  const close = async () => {
    const failures = [];
    for (const fiber of [...mounted].reverse()) {
      try { await fiber.dispose(); } catch (error) { failures.push(error); }
    }
    try { await ctx.fiber.dispose(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'GUI seed Context cleanup failed');
  };
  try {
    await mount(Storage);
    await mount(storageJson, { root: paths.storages });
    await mount(storageDomain, { backend: 'json' });
    await mount(SessionStore);
    await mount(Jsonl, { root: paths.sessions, compression: 'zstd' });
    if (seed) {
      const cliLookup = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
      const baseLookup = createRequire(cliLookup.resolve('@deepseek-ai/dsh-base/package.json'));
      const projections = await import(pathToFileURL(baseLookup.resolve('@deepseek-ai/dsh-session-projection')).href);
      const title = await import(pathToFileURL(baseLookup.resolve('@deepseek-ai/dsh-session-title')).href);
      const cache = await import(pathToFileURL(baseLookup.resolve('@deepseek-ai/dsh-session-projection-cache')).href);
      await mount(projections.default);
      ctx.sessionProjections.register(title.titleProjectionDefinition);
      await mount(cache.default, { writeEveryEvents: 200, writeIntervalMs: 5000 });
      for (const [index, fixture] of fixtures.entries()) {
        const session = ctx.sessions.prepare(SessionId(fixture.id), {
          meta: { cwd: paths[fixture.workspace], createdAt: Date.now() - index * 1000 },
        });
        const handle = await ctx.sessionPersistence.create(session.header);
        try {
          // Native session-list metadata treats a log without turn/start as a
          // provisional blank. A completed fixture turn makes its row/menu real;
          // the public user title remains log-only and activates no model.
          const time = Date.now();
          await handle.append([
            { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
            { type: 'turn/end', seq: 1, time: time + 1, data: { turn: 1, reason: { kind: 'completed' } } },
            { type: 'session/title', seq: 2, time: time + 2, data: {
              title: fixture.title, messageSeqs: [], source: { kind: 'user' },
            } },
          ]);
          await handle.flush();
          const persisted = await handle.read();
          ctx.sessionProjectionCache.coldSnapshot(handle.header, handle.inheritedEventCount, persisted.events);
          await eventually(async () => {
            assert.equal(ctx.sessionProjectionCache.cachedSnapshot(handle.header)?.values.title, fixture.title);
          }, 'Title projection must become durable before the real Web startup');
        } finally { await handle.close(); }
      }
    }
    await mount(WorkspaceRegistry);
    if (seed) {
      const primary = await ctx.workspaceRegistry.resolveByPath(paths.primary);
      const secondary = await ctx.workspaceRegistry.resolveByPath(paths.secondary);
      assert(primary && secondary, 'Seeded real headers must bootstrap both workspaces');
      await primary.setTitle(fixtureWorkspaces.primary);
      await secondary.setTitle(fixtureWorkspaces.secondary);
      for (const fixture of fixtures.filter(item => item.archived)) {
        await ctx.workspaceRegistry.archiveSession(SessionId(fixture.id));
      }
    }
    return { ctx, close };
  } catch (error) { await close(); throw error; }
}
async function readLogs(fixture) {
  const logs = {};
  for (const item of fixtures) {
    const handle = await fixture.ctx.sessionPersistence.open(SessionId(item.id), 'read');
    try { logs[item.id] = structuredClone(await handle.read()); }
    finally { await handle.close(); }
  }
  return logs;
}
async function eventually(assertion, description, timeout = 15000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    cancellation.signal.throwIfAborted();
    try { return await assertion(); } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${description}: ${redact(last?.message ?? last)}`, { cause: last });
}
async function clickChoice(page, label) {
  const choice = menuItem(page, label);
  if (await choice.count()) await choice.click();
  else await text(page, label).click();
}
async function showAllSessions(page) {
  await button(page, ui.viewOptions).click();
  await clickChoice(page, ui.showArchived);
  await button(page, ui.viewOptions).click();
  await clickChoice(page, ui.flat);
}
async function rowMenu(page, id) {
  const row = page.locator(`[data-row-key="session:${id}"]`).first();
  await row.waitFor({ state: 'visible' });
  await row.hover();
  const anchor = row.getByRole('button').first();
  await anchor.click();
  return anchor;
}
async function assertToastCopy(page, message) {
  const toast = page.getByRole('alert').filter({ hasText: message });
  await toast.waitFor({ state: 'visible' });
  const directMessages = await toast.locator('span').evaluateAll(nodes => nodes.map(node =>
    [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('')));
  assert(directMessages.includes(message), `Native Toast message must exactly equal ${JSON.stringify(message)}`);
}
async function moveSession(page, id) {
  await rowMenu(page, id);
  await menuItem(page, ui.move).click();
  await assertToastCopy(page, ui.moved);
}
async function panel(page) {
  const search = textbox(page, ui.search);
  await button(page, ui.panel).waitFor({ state: 'visible' });
  if (!await search.isVisible()) await button(page, ui.panel).click();
  await search.waitFor({ state: 'visible' });
  return page.getByRole('region', { name: ui.panel, exact: true });
}
async function panelCount(root, count) {
  await eventually(async () => assert.equal(await root.getByRole('listitem').count(), count), 'Bin row count');
}
function panelEntry(root, title) {
  return root.getByRole('listitem').filter({ has: root.page().getByText(title, { exact: true }) });
}
async function screenshot(page, paths, name) {
  const path = join(paths.artifacts, `${name}-${language}.png`);
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  return path;
}
async function assertDocumentLanguage(page) {
  await page.waitForFunction(expected => document.documentElement.lang === expected, ui.htmlLanguage);
}
async function skipModelSetup(page) {
  const dialog = page.getByRole('dialog', { name: ui.keySetup, exact: true });
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  await button(dialog, ui.configureLater).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function assertDates(root) {
  const values = await root.locator('time[datetime]').evaluateAll((nodes, locale) => nodes.map(node => ({
    value: node.getAttribute('datetime'), actual: node.textContent,
    expected: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(node.getAttribute('datetime'))),
  })), language);
  assert(values.length > 0, 'Rendered nonempty Bin rows must expose their timestamps');
  for (const value of values) assert.equal(value.actual, value.expected, `Timestamp must use the selected ${language} Intl format`);
  return values.map(value => ({ value: value.value, text: value.actual }));
}
async function assertPanelCopy(page, count, { visibleCount = count, selectedCount = 0, draft = '' } = {}) {
  await assertDocumentLanguage(page);
  const root = await panel(page);
  await panelCount(root, visibleCount);
  await root.getByRole('heading', { level: 1, name: ui.panel, exact: true }).waitFor({ state: 'visible' });
  await text(root, ui.description).waitFor({ state: 'visible' });
  await text(root, ui.count(count)).waitFor({ state: 'visible' });
  assert.equal(await textbox(root, ui.search).inputValue(), draft, 'Language changes must not replace the search draft');
  assert.equal(await textbox(root, ui.search).getAttribute('placeholder'), ui.search);
  await button(root, ui.refresh).waitFor({ state: 'visible' });
  const filter = root.getByRole('combobox', { name: ui.workspace, exact: true });
  assert.equal(await filter.locator('option').first().textContent(), ui.allWorkspaces);
  assert.equal(await filter.locator('option').last().textContent(), ui.ungrouped);
  const opposite = copy[language === 'zh' ? 'en' : 'zh'];
  assert.equal(await button(page, opposite.panel).count(), 0, 'Sidebar label must update rather than accept either language');
  if (count === 0) {
    await text(root, ui.empty).waitFor({ state: 'visible' });
    await text(root, ui.emptyHint).waitFor({ state: 'visible' });
    assert.equal(await root.getByRole('checkbox', { name: ui.selectAll, exact: true }).count(), 0);
  } else if (visibleCount === 0) {
    await text(root, ui.noMatches).waitFor({ state: 'visible' });
    await text(root, ui.noMatchesHint).waitFor({ state: 'visible' });
    assert.equal(await text(root, ui.empty).count(), 0);
  } else {
    await root.getByRole('list', { name: ui.entries, exact: true }).waitFor({ state: 'visible' });
    await root.getByRole('checkbox', { name: ui.selectAll, exact: true }).waitFor({ state: 'visible' });
    await assertDates(root);
  }
  if (selectedCount) {
    await text(root, ui.selected(selectedCount)).waitFor({ state: 'visible' });
    await button(root, ui.clearSelection).waitFor({ state: 'visible' });
    await button(root, ui.restoreSelected).waitFor({ state: 'visible' });
  } else {
    assert.equal(await button(root, ui.clearSelection).count(), 0);
  }
  return root;
}
async function switchLanguage(page, target, report) {
  const before = language;
  await button(page, ui.settings).click();
  const currentDialog = page.getByRole('dialog', { name: ui.settings, exact: true });
  await currentDialog.waitFor({ state: 'visible' });
  await button(currentDialog, ui.general).click();
  // The shipped Language row uses the self-described catalog label as its
  // native menu anchor. The menu is portaled outside the Settings dialog.
  await button(currentDialog, ui.languageLabel).click();
  await menuItem(page, copy[target].languageLabel).click();
  language = target;
  ui = copy[language];
  await assertDocumentLanguage(page);
  const translatedDialog = page.getByRole('dialog', { name: ui.settings, exact: true });
  await button(translatedDialog, ui.settingsClose).click();
  await translatedDialog.waitFor({ state: 'hidden' });
  await button(page, ui.panel).waitFor({ state: 'visible' });
  report.languageSwitches.push({ from: before, to: target, source: 'native Settings General Language menu' });
}
async function assertMenuCopy(page, id, owned) {
  const anchor = await rowMenu(page, id);
  const expected = owned ? ui.restore : ui.move;
  await menuItem(page, expected).waitFor({ state: 'visible' });
  const opposite = copy[language === 'zh' ? 'en' : 'zh'];
  assert.equal(await menuItem(page, owned ? opposite.restore : opposite.move).count(), 0);
  await menuItem(page, expected).focus();
  await page.keyboard.press('Escape');
  await eventually(async () => assert(await anchor.evaluate(element => element === document.activeElement)), 'Menu restores focus after Escape');
}
async function assertOriginalArchive(root, title) {
  const row = panelEntry(root, title);
  await text(row, ui.originalArchive).waitFor({ state: 'visible' });
  assert.equal(await text(row, ui.originalArchive).getAttribute('title'), ui.originalArchiveHint);
  assert.equal(await button(row, ui.restore).getAttribute('title'), ui.originalArchiveHint);
}
async function assertNarrowLayout(page, root, report) {
  await page.setViewportSize({ width: 390, height: 844 });
  await textbox(root, ui.search).waitFor({ state: 'visible' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  report.narrowLayout = await root.evaluate(element => {
    const bounds = node => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }; };
    return { viewport: { width: innerWidth, height: innerHeight }, panel: bounds(element),
      controls: [...element.querySelectorAll('input,select,button')].map(node => ({ label: node.getAttribute('aria-label') || node.textContent, ...bounds(node) })) };
  });
  const layout = report.narrowLayout;
  assert(layout.panel.right <= layout.viewport.width + 1 && layout.panel.x >= 0, 'Bin panel must fit the narrow viewport');
  assert(layout.controls.every(control => control.right <= layout.viewport.width + 1 && control.x >= 0), 'All narrow controls must fit horizontally');
  const restore = layout.controls.find(control => control.label === ui.restoreSelected);
  assert(restore && restore.y >= 0 && restore.bottom <= layout.viewport.height + 1, 'Batch restore must remain visible in the narrow viewport');
}
async function runGui(page, paths, report) {
  const [quiet, sibling, nativeOnly, prearchived] = fixtures;
  await page.waitForFunction(() => Array.isArray(window.__DSH_BOOT__?.entries));
  assert(await page.evaluate(() => window.__DSH_BOOT__.entries.some(entry => entry.id === 'dsh-session-bin')),
    'The packed client must appear in the real injected boot graph');
  await Promise.race([
    button(page, ui.panel).waitFor({ state: 'visible' }),
    text(page, 'Failed to load plugins').waitFor({ state: 'visible' }).then(async () => {
      throw new Error(`Real Web client boot failed: ${await page.locator('body').innerText()}`);
    }),
  ]);
  await assertDocumentLanguage(page);
  const preview = page.getByRole('dialog', { name: ui.preview, exact: true });
  await preview.waitFor({ state: 'visible', timeout: 10000 });
  await button(preview, ui.continue).click();
  await preview.waitFor({ state: 'hidden' });
  report.checks.push('The fresh isolated profile acknowledges its exact-language native preview notice');
  await skipModelSetup(page);
  report.checks.push('The isolated profile skips native model setup without credentials');
  await showAllSessions(page);
  let root = await assertPanelCopy(page, 0);
  assert.equal(await text(root, nativeOnly.title).count(), 0);
  report.checks.push('Exact-language empty title, description, count, placeholder and filter copy; native archives excluded');
  report.coverage.push('panel title/description/sidebar label', 'empty state and hint', 'zero/singular/plural counts', 'search placeholder and accessible label', 'workspace filter options');

  await assertMenuCopy(page, quiet.id, false);
  report.checks.push('The exact-language native menu remains keyboard accessible and returns focus after Escape');
  await moveSession(page, quiet.id);
  const undo = button(page, ui.undo);
  await undo.waitFor({ state: 'visible' });
  await undo.click();
  await text(page, ui.restored).waitFor({ state: 'visible' });
  await button(page, ui.refresh).click();
  root = await assertPanelCopy(page, 0);
  assert.equal(await page.locator(`[data-row-key="session:${quiet.id}"]`).getAttribute('aria-description'), null);
  report.checks.push('Move and Undo use exact selected-language menu and Toast text through actual transport');
  report.coverage.push('move menu and moved Toast', 'Undo action and restored Toast', 'native menu keyboard/focus');

  await moveSession(page, quiet.id);
  await button(page, ui.refresh).click();
  root = await assertPanelCopy(page, 1);
  await panelEntry(root, quiet.title).getByRole('checkbox', { name: ui.select(quiet.title), exact: true }).waitFor({ state: 'visible' });
  await button(panelEntry(root, quiet.title), ui.restore).click();
  await text(page, ui.restored).waitFor({ state: 'visible' });
  root = await assertPanelCopy(page, 0);
  report.checks.push('Single-row Restore, localized selection label and singular count render correctly');

  for (const item of [quiet, sibling, prearchived]) await moveSession(page, item.id);
  await button(page, ui.refresh).click();
  root = await assertPanelCopy(page, 3);
  for (const item of [quiet, sibling, prearchived]) await text(root, item.title).waitFor({ state: 'visible' });
  assert.equal(await text(root, nativeOnly.title).count(), 0);
  await assertOriginalArchive(root, prearchived.title);
  report.coverage.push('original archive badge and restore hint', 'selected-language Intl dates', 'CJK user titles remain unchanged');
  report.checks.push('User titles and workspace names stay untranslated; original archive copy and Intl dates match the selected language');

  let search = textbox(root, ui.search);
  await search.fill('接口');
  root = await assertPanelCopy(page, 3, { visibleCount: 1, draft: '接口' });
  await text(root, sibling.title).waitFor({ state: 'visible' });
  await search.fill('no match 不存在 🧪');
  root = await assertPanelCopy(page, 3, { visibleCount: 0, draft: 'no match 不存在 🧪' });
  await search.fill('');
  root = await assertPanelCopy(page, 3);
  await search.dispatchEvent('compositionstart', { data: '接' });
  await search.fill('接口');
  assert.equal(await search.inputValue(), '接口');
  await panelCount(root, 3);
  await search.dispatchEvent('compositionend', { data: '接口' });
  await panelCount(root, 1);
  await search.press('Escape');
  assert.equal(await search.inputValue(), '');
  await panelCount(root, 3);
  await search.focus();
  await page.keyboard.insertText('中文输入验证');
  assert.equal(await search.inputValue(), '中文输入验证');
  await panelCount(root, 0);
  await search.fill('');
  await panelCount(root, 3);
  await search.focus();
  await page.keyboard.press('Tab');
  assert(await root.evaluate(element => element.contains(document.activeElement)), 'Tab must focus a visible feature control');
  report.coverage.push('no-matches state and hint', 'search/IME composition/Escape/keyboard text/Tab');
  report.checks.push('Exact no-matches copy and composition/keyboard behavior work in the selected UI language');
  report.limits.push('Chinese insertText and synthetic composition events exercise browser handling, not a physical OS input-method session');

  const workspaceFilter = root.getByRole('combobox', { name: ui.workspace, exact: true });
  await workspaceFilter.selectOption({ label: fixtureWorkspaces.primary });
  await panelCount(root, 2);
  await workspaceFilter.selectOption({ label: fixtureWorkspaces.secondary });
  await panelCount(root, 1);
  await workspaceFilter.selectOption('all');
  await panelCount(root, 3);
  report.checks.push('Current native membership filters correctly and user workspace names remain unchanged');

  const choose = async () => {
    await panelEntry(root, quiet.title).getByRole('checkbox', { name: ui.select(quiet.title), exact: true }).check();
    await panelEntry(root, sibling.title).getByRole('checkbox', { name: ui.select(sibling.title), exact: true }).check();
    root = await assertPanelCopy(page, 3, { selectedCount: 2 });
  };
  await choose();
  await button(root, ui.clearSelection).click();
  root = await assertPanelCopy(page, 3);
  assert.equal(await panelEntry(root, quiet.title).getByRole('checkbox').isChecked(), false);
  assert.equal(await panelEntry(root, sibling.title).getByRole('checkbox').isChecked(), false);
  await choose();
  report.coverage.push('row/select-all checkbox labels', 'selected count', 'clear selection', 'batch restore action');
  report.checks.push('Selection and clear-selection controls use exact selected-language labels');

  // A native Settings modal changes language without navigating away from the
  // Bin, so the component's selection and search draft must remain intact.
  search = textbox(root, ui.search);
  await search.fill('接口');
  root = await assertPanelCopy(page, 3, { visibleCount: 1, selectedCount: 2, draft: '接口' });
  if (language !== 'zh') {
    await switchLanguage(page, 'zh', report);
    root = await assertPanelCopy(page, 3, { visibleCount: 1, selectedCount: 2, draft: '接口' });
  }
  const datesByLanguage = {};
  for (const target of ['en', 'zh']) {
    await switchLanguage(page, target, report);
    root = await assertPanelCopy(page, 3, { visibleCount: 1, selectedCount: 2, draft: '接口' });
    assert.equal(await panelEntry(root, sibling.title).getByRole('checkbox', { name: ui.select(sibling.title), exact: true }).isChecked(), true);
    for (const item of [quiet, sibling, nativeOnly, prearchived]) {
      await text(page.locator(`[data-row-key="session:${item.id}"]`), item.title).waitFor({ state: 'visible' });
    }
    await assertMenuCopy(page, quiet.id, true);
    datesByLanguage[target] = await assertDates(root);
    report.screenshots[`switched-${target}`] = await screenshot(page, paths, 'session-bin-language-switch');
  }
  assert.equal(datesByLanguage.en[0].value, datesByLanguage.zh[0].value, 'Language switching must not change binnedAt');
  assert.notEqual(datesByLanguage.en[0].text, datesByLanguage.zh[0].text, 'Dates must reflect the chosen Intl language');
  report.dateSwitch = datesByLanguage;
  report.coverage.push('native Settings zh→en→zh', 'sidebar label updates', 'selection/search draft preserved during language changes', 'menu/date updates without translating user data');
  report.checks.push('Actual Host Settings language changes update panel/menu/sidebar/date and preserve selected entries and the search draft');

  // Persist a Host language DIFFERENT from navigator, then refresh the same
  // browser. This establishes preference persistence rather than redetecting
  // the original browser language after a reload.
  const hostPreference = requestedLanguage === 'zh' ? 'en' : 'zh';
  await switchLanguage(page, hostPreference, report);
  root = await assertPanelCopy(page, 3, { visibleCount: 1, selectedCount: 2, draft: '接口' });
  await page.reload();
  await assertDocumentLanguage(page);
  await skipModelSetup(page);
  root = await assertPanelCopy(page, 3);
  report.preferenceReload = { browserLocale, hostPreference, renderedHtmlLanguage: await page.locator('html').getAttribute('lang') };
  await switchLanguage(page, requestedLanguage, report);
  root = await assertPanelCopy(page, 3);
  report.coverage.push('Host preference survives refresh and overrides navigator language');
  report.checks.push('Refreshing the unchanged browser retains the explicit opposite Host preference');

  // Select anew after the deliberate full-page reload; language switching above
  // preserved local selection, while a new document reconstructs the view.
  await choose();
  await assertOriginalArchive(root, prearchived.title);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'));
  report.screenshots.light = await screenshot(page, paths, 'session-bin-light');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'));
  report.screenshots.dark = await screenshot(page, paths, 'session-bin-dark');
  await assertNarrowLayout(page, root, report);
  report.screenshots.narrow = await screenshot(page, paths, 'session-bin-narrow');
  report.coverage.push('light/dark palettes', '390px selected-language controls and English text do not overflow');
  report.checks.push('All controls and the batch action fit the 390px selected-language viewport');
  await page.setViewportSize({ width: 1440, height: 900 });
  await button(root, ui.restoreSelected).click();
  await panelCount(root, 1);
  await assertOriginalArchive(root, prearchived.title);
  await button(panelEntry(root, prearchived.title), ui.restore).click();
  await text(page, ui.restoredArchived).waitFor({ state: 'visible' });
  root = await assertPanelCopy(page, 0);
  for (const item of [nativeOnly, prearchived]) {
    await eventually(async () => assert(await page.locator(`[data-row-key="session:${item.id}"]`).getAttribute('aria-description')),
      'Originally archived session remains natively archived');
  }
  report.coverage.push('original archive restore Toast', 'single/batch restore');
  report.checks.push('Batch Restore and exact prior-archive Toast preserve the native archive');

  // Visiting the Plugins page intentionally changes the main panel; test its
  // package copy after selection is complete, not during preservation checks.
  for (const target of [requestedLanguage, requestedLanguage === 'zh' ? 'en' : 'zh']) {
    if (language !== target) await switchLanguage(page, target, report);
    await button(page, ui.plugins).click();
    await button(page, ui.openDetail(ui.panel)).click();
    const detail = page.locator('[data-plugin-detail="dsh-session-bin"]');
    await detail.getByRole('heading', { name: ui.panel, level: 3, exact: true }).waitFor({ state: 'visible' });
    const description = detail.getByRole('paragraph').filter({ hasText: ui.packageDescription });
    await description.waitFor({ state: 'visible' });
    assert.equal(await description.textContent(), ui.packageDescription, 'Native Plugins description must exactly match the chosen language');
    report.metadata.push({ language: target, title: ui.panel, description: ui.packageDescription });
    await panel(page);
  }
  if (language !== requestedLanguage) await switchLanguage(page, requestedLanguage, report);
  report.coverage.push('native Plugins localized package title/description');
  await page.reload();
  await assertDocumentLanguage(page);
  await skipModelSetup(page);
  root = await assertPanelCopy(page, 0);
  report.checks.push('Both native Plugins metadata languages and the final selected Host preference survive page reload');
}

async function main() {
  const parent = join(workspace, '.local', 'gui');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  scratch = await mkdtemp(join(parent, `client-${requestedLanguage}-`));
  ownsPath(await realpath(workspace), await realpath(scratch));
  const paths = {
    home: join(scratch, 'dsh-home'), primary: join(scratch, 'workspace'), secondary: join(scratch, 'second-workspace'),
    sessions: join(scratch, 'dsh-home', 'sessions'), storages: join(scratch, 'dsh-home', 'storages'),
    browser: join(scratch, 'browser-profile'), artifacts: join(scratch, 'artifacts'), tmp: join(scratch, 'tmp'),
    userconfig: join(scratch, 'empty-user.npmrc'), globalconfig: join(scratch, 'empty-global.npmrc'),
  };
  await Promise.all([paths.home, paths.primary, paths.secondary, paths.artifacts, paths.tmp].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await Promise.all([writeFile(paths.userconfig, ''), writeFile(paths.globalconfig, '')]);
  const environment = {
    ...process.env, DSH_HOME: paths.home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write',
    CI: 'true', NO_UPDATE_NOTIFIER: '1',
    TMPDIR: paths.tmp, XDG_CONFIG_HOME: join(scratch, 'xdg-config'), XDG_CACHE_HOME: join(scratch, 'xdg-cache'),
    XDG_DATA_HOME: join(scratch, 'xdg-data'), XDG_STATE_HOME: join(scratch, 'xdg-state'),
    npm_config_userconfig: paths.userconfig, npm_config_globalconfig: paths.globalconfig, npm_config_cache: join(scratch, 'npm-cache'),
    npm_config_ignore_scripts: 'true',
    PNPM_CONFIG_IGNORE_SCRIPTS: 'true', PNPM_CONFIG_UPDATE_NOTIFIER: 'false',
    PNPM_CONFIG_USERCONFIG: paths.userconfig, PNPM_CONFIG_GLOBALCONFIG: paths.globalconfig,
  };
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN',
    'DSH_SNAPSHOT', 'DSH_WEB_URL', 'DSH_PROFILE', 'NODE_OPTIONS']) delete environment[key];
  const cli = await realpath(require.resolve('@deepseek-ai/dsh/lib/bin.js'));
  assert(!cli.includes(`${sep}.local${sep}dsh-runtime${sep}`), 'Use the installed public npm CLI');
  const cliRequire = createRequire(cli);
  assert.equal(JSON.parse(await readFile(cliRequire.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version, expectedSdk);
  const webRequire = createRequire(cliRequire.resolve('@deepseek-ai/dsh-web-app/package.json'));
  const frontend = dirname(webRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json'));
  await access(join(frontend, 'dist', 'index.html'));
  const executable = process.env.DSH_GUI_BROWSER_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executable);
  const report = {
    status: 'running', sdk: expectedSdk, node: process.version, platform: process.platform, arch: process.arch,
    scratch, locale: browserLocale, requestedLanguage, checks: [], coverage: [], languageSwitches: [], metadata: [],
    screenshots: {}, limits: [], browserConsole: [], browserConsoleDetails: [], pageErrors: [],
  };
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = paths.home;
  let beforeLogs;
  try {
    const fixture = await openSdkFixture(paths, true);
    try { beforeLogs = await readLogs(fixture); }
    finally { await fixture.close(); }
    const packed = await runCommand('npm', ['pack', '--json', '--ignore-scripts', '--offline',
      '--userconfig', paths.userconfig, '--globalconfig', paths.globalconfig,
      '--cache', join(scratch, 'npm-cache'), '--pack-destination', scratch], {
      cwd: workspace, env: environment,
    }, 'Packing the client tarball');
    const [metadata] = JSON.parse(packed.stdout);
    const tarball = join(scratch, metadata.filename);
    ownsPath(scratch, tarball);
    report.tarball = tarball;
    report.sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
    const store = join(workspace, '.local', 'pnpm-store');
    const cache = join(workspace, '.local', 'pnpm-cache');
    await runCommand(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', tarball,
      '--ignore-scripts', '--offline', `--store-dir=${store}`, `--cache-dir=${cache}`], {
      cwd: paths.primary, env: environment,
    }, 'Installing the tarball through dsh plugin');
    const profilePath = join(paths.home, 'profiles', 'web', 'package.json');
    const profile = JSON.parse(await readFile(profilePath, 'utf8'));
    assert(profile.dsh.profile.bundles.includes('dsh-session-bin'), 'CLI installation must register the Bin bundle');
    report.checks.push('Public dsh plugin installs and activates the packed bundle in a new Web profile');
    const host = await startHost(cli, environment, paths.primary, 'host.log');
    report.url = host.cleanUrl;
    browserContext = await chromium.launchPersistentContext(paths.browser, {
      executablePath: executable, headless: true, locale: browserLocale, viewport: { width: 1440, height: 900 },
      colorScheme: 'light', reducedMotion: 'reduce', env: environment,
      args: ['--no-proxy-server', '--disable-breakpad', '--disable-crash-reporter'],
    });
    report.browser = browserContext.browser()?.version() ?? 'system Chrome';
    const page = browserContext.pages()[0] ?? await browserContext.newPage();
    page.setDefaultTimeout(15000);
    const pageErrors = report.pageErrors;
    page.on('pageerror', error => pageErrors.push(redact(error.message)));
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') {
        report.browserConsole.push(redact(message.text()));
        if (report.browserConsole.length > 100) report.browserConsole.shift();
        void Promise.all(message.args().map(argument => argument.evaluate(value => {
          const seen = new Set();
          const copy = (item, depth = 0) => {
            if (item === null || typeof item !== 'object') return typeof item === 'function' ? '[function]' : item;
            if (seen.has(item) || depth > 5) return '[truncated]';
            seen.add(item);
            if (Array.isArray(item)) return item.slice(0, 20).map(child => copy(child, depth + 1));
            const result = {};
            const keys = new Set(['name', 'message', 'stack', 'code', 'cause', 'errors', 'failures', 'details', 'entries', 'id', 'status', 'type', ...Object.getOwnPropertyNames(item)]);
            const excluded = new Set(['ctx', 'context', 'fiber', 'parent', 'runtime', 'store', 'config', 'configuration']);
            for (const key of [...keys].filter(key => !excluded.has(key)).slice(0, 24)) {
              try { if (item[key] !== undefined) result[key] = copy(item[key], depth + 1); } catch {}
            }
            return result;
          };
          return copy(value);
        }))).then(details => {
          report.browserConsoleDetails.push(JSON.parse(redact(JSON.stringify(details))));
        }).catch(() => {});
      }
    });
    await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(url => !url.searchParams.has('token'));
    assert.equal(new URL(page.url()).origin, new URL(host.cleanUrl).origin);
    await runGui(page, paths, report);
    assert.deepEqual(pageErrors, [], `Unexpected browser errors: ${pageErrors.join('\n')}`);
    await browserContext.close();
    browserContext = undefined;
    const stopped = await stopChild(host.child);
    assert.equal(stopped.forced, false, 'Normal GUI verification must allow graceful Host disposal');
    assert.equal(stopped.code, 0, 'SIGTERM must complete the public CLI shutdown successfully');
    await writeFile(join(scratch, host.logName), host.log);
    activeHost = undefined;
    const after = await openSdkFixture(paths);
    try {
      assert.deepEqual(await readLogs(after), beforeLogs, 'Bin GUI operations must preserve all fixture transcripts');
      const archived = after.ctx.workspaceRegistry.archivedSessionIds;
      assert(archived.includes('gui-native-only') && archived.includes('gui-prearchived'));
      assert(!archived.includes('gui-quiet') && !archived.includes('gui-sibling'));
    } finally { await after.close(); }
    report.checks.push('SDK reopen confirms native archive state and unchanged fixture transcripts');
    await runCommand(process.execPath, [cli, 'plugin', '--profile', 'web', 'remove', 'dsh-session-bin',
      `--store-dir=${store}`, `--cache-dir=${cache}`], { cwd: paths.primary, env: environment }, 'Uninstalling the test bundle');
    const removed = JSON.parse(await readFile(profilePath, 'utf8'));
    assert(!removed.dsh.profile.bundles.includes('dsh-session-bin'));
    const withoutBin = await startHost(cli, environment, paths.primary, 'host-after-uninstall.log');
    browserContext = await chromium.launchPersistentContext(paths.browser, {
      executablePath: executable, headless: true, locale: browserLocale, viewport: { width: 1440, height: 900 }, env: environment,
      args: ['--no-proxy-server', '--disable-breakpad', '--disable-crash-reporter'],
    });
    const reloaded = browserContext.pages()[0] ?? await browserContext.newPage();
    reloaded.setDefaultTimeout(15000);
    await reloaded.goto(withoutBin.authenticatedUrl, { waitUntil: 'domcontentloaded' });
    await reloaded.waitForFunction(() => Array.isArray(window.__DSH_BOOT__?.entries));
    assert(!await reloaded.evaluate(() => window.__DSH_BOOT__.entries.some(entry => entry.id === 'dsh-session-bin')));
    await assertDocumentLanguage(reloaded);
    await skipModelSetup(reloaded);
    await button(reloaded, ui.viewOptions).waitFor({ state: 'visible' });
    assert.equal(await button(reloaded, ui.panel).count(), 0);
    await browserContext.close();
    browserContext = undefined;
    const removedStopped = await stopChild(withoutBin.child);
    assert.equal(removedStopped.forced, false);
    assert.equal(removedStopped.code, 0);
    await writeFile(join(scratch, withoutBin.logName), withoutBin.log);
    activeHost = undefined;
    report.checks.push('Public CLI uninstall and a fresh true Web boot remove the client contribution');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = redact(error.stack ?? error);
    if (browserContext) {
      try {
        const page = browserContext.pages()[0];
        if (page) {
          report.screenshots.failure = await screenshot(page, paths, 'failure');
          report.pageText = redact(await page.locator('body').innerText());
        }
      } catch {}
    }
    throw error;
  } finally {
    try { await browserContext?.close(); } catch {}
    browserContext = undefined;
    if (activeHost) {
      report.shutdown = await stopChild(activeHost.child);
      await writeFile(join(scratch, activeHost.logName), activeHost.log);
      activeHost = undefined;
    }
    for (const child of [...children]) await stopChild(child);
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    const reportPath = join(scratch, 'verification.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
  }
}
function onInterrupt() {
  cancellation.abort(new Error('GUI verification was interrupted'));
  for (const child of children) signalChild(child, 'SIGTERM');
  void browserContext?.close().catch(() => {});
}
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onInterrupt);
try { await main(); }
catch (error) { console.error(redact(error.stack ?? error)); process.exitCode = 1; }
finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt); }
