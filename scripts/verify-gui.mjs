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
const ui = {
  panel: /^(?:会话回收站|Session Bin)$/,
  move: /^(?:移入回收站|Move to (?:the )?(?:recycle bin|bin|Session Bin))$/i,
  restore: /^(?:恢复|Restore)$/i,
  undo: /^(?:撤销|Undo)$/i,
  search: /^(?:搜索回收站|Search (?:the )?(?:bin|recycle bin|Session Bin))$/i,
  workspace: /^(?:工作区筛选|Workspace filter)$/i,
  restoreSelected: /^(?:恢复所选|Restore selected)$/i,
  refresh: /^(?:刷新|Refresh)$/i,
  viewOptions: /^(?:视图选项|View options)$/i,
  showArchived: /^(?:全部对话（显示已归档）|All conversations \(show archived\))$/i,
  flat: /^(?:单列表|In one list)$/i,
};
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
      await primary.setTitle('GUI 主工作区');
      await secondary.setTitle('GUI 第二工作区');
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
  const choice = page.getByRole('menuitem', { name: label });
  if (await choice.count()) await choice.click();
  else await page.getByText(label).click();
}
async function showAllSessions(page) {
  await page.getByRole('button', { name: ui.viewOptions }).click();
  await clickChoice(page, ui.showArchived);
  await page.getByRole('button', { name: ui.viewOptions }).click();
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
async function moveSession(page, id) {
  await rowMenu(page, id);
  await page.getByRole('menuitem', { name: ui.move }).click();
}
async function panel(page) {
  const search = page.getByRole('textbox', { name: ui.search });
  await page.getByRole('button', { name: ui.panel }).waitFor({ state: 'visible' });
  if (!await search.isVisible()) await page.getByRole('button', { name: ui.panel }).click();
  await search.waitFor({ state: 'visible' });
  return page.getByRole('region', { name: ui.panel });
}
async function panelCount(root, count) {
  await eventually(async () => assert.equal(await root.getByRole('listitem').count(), count), 'Bin row count');
}
function panelEntry(root, title) {
  return root.getByRole('listitem').filter({ has: root.page().getByText(title, { exact: true }) });
}
async function screenshot(page, paths, name) {
  const path = join(paths.artifacts, `${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  return path;
}
async function runGui(page, paths, report) {
  const [quiet, sibling, nativeOnly, prearchived] = fixtures;
  await page.waitForFunction(() => Array.isArray(window.__DSH_BOOT__?.entries));
  assert(await page.evaluate(() => window.__DSH_BOOT__.entries.some(entry => entry.id === 'dsh-session-bin')),
    'The packed client must appear in the real injected boot graph');
  await Promise.race([
    page.getByRole('button', { name: ui.panel }).waitFor({ state: 'visible' }),
    page.getByText('Failed to load plugins', { exact: true }).waitFor({ state: 'visible' }).then(async () => {
      throw new Error(`Real Web client boot failed: ${await page.locator('body').innerText()}`);
    }),
  ]);
  const preview = page.getByRole('dialog', { name: /^(?:预览版说明|Preview Notice)$/ });
  await preview.waitFor({ state: 'visible', timeout: 10000 });
  await preview.getByRole('button', { name: /^(?:继续|Continue)$/ }).click();
  await preview.waitFor({ state: 'hidden' });
  report.checks.push('The fresh isolated profile acknowledges its own native preview notice');
  const keySetup = page.getByRole('dialog', { name: /^(?:添加一个 API Key 开始使用|Add an API key to get started)$/i });
  await keySetup.waitFor({ state: 'visible', timeout: 10000 });
  await keySetup.getByRole('button', { name: /^(?:稍后配置|Configure later)$/i }).click();
  await keySetup.waitFor({ state: 'hidden' });
  report.checks.push('The isolated profile skips model setup through its native Configure later action without credentials');
  await showAllSessions(page);
  let root = await panel(page);
  await panelCount(root, 0);
  assert.equal(await root.getByText(nativeOnly.title, { exact: true }).count(), 0);
  report.checks.push('Independent native archives are excluded from the empty Bin');

  const anchor = await rowMenu(page, quiet.id);
  await page.getByRole('menuitem', { name: ui.move }).focus();
  await page.keyboard.press('Escape');
  await eventually(async () => assert(await anchor.evaluate(element => element === document.activeElement)), 'Menu restores focus after Escape');
  report.checks.push('Native row menu remains keyboard accessible and restores focus');
  await moveSession(page, quiet.id);
  const undo = page.getByRole('button', { name: ui.undo });
  await undo.waitFor({ state: 'visible' });
  await undo.click();
  await page.getByRole('button', { name: ui.refresh }).click();
  await panelCount(root, 0);
  assert.equal(await page.locator(`[data-row-key="session:${quiet.id}"]`).getAttribute('aria-description'), null);
  report.checks.push('Row move and Toast Undo restore a previously unarchived session');

  await moveSession(page, quiet.id);
  await page.getByRole('button', { name: ui.refresh }).click();
  await panelCount(root, 1);
  await panelEntry(root, quiet.title).getByRole('button', { name: ui.restore }).click();
  await panelCount(root, 0);
  report.checks.push('Single-row panel Restore completes through the actual transport');

  for (const item of [quiet, sibling, prearchived]) await moveSession(page, item.id);
  await page.getByRole('button', { name: ui.refresh }).click();
  await panelCount(root, 3);
  for (const item of [quiet, sibling, prearchived]) {
    await root.getByText(item.title, { exact: true }).waitFor({ state: 'visible' });
  }
  assert.equal(await root.getByText(nativeOnly.title, { exact: true }).count(), 0);
  report.checks.push('Three plugin-owned titles render and the native-only archive stays excluded');

  const search = root.getByRole('textbox', { name: ui.search });
  await search.fill('接口');
  await panelCount(root, 1);
  await root.getByText(sibling.title, { exact: true }).waitFor({ state: 'visible' });
  await search.fill('');
  await panelCount(root, 3);
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
  assert(await root.evaluate(element => element.contains(document.activeElement)), 'Tab focus must stay on a visible feature control');
  report.checks.push('Search filters native titles; composition completion, Escape, keyboard text input and Tab navigation work');
  report.limits.push('Chinese insertText and synthetic composition events exercise browser input handling, not a physical OS input-method session');

  const workspaceFilter = root.getByRole('combobox', { name: ui.workspace });
  await workspaceFilter.selectOption({ label: 'GUI 主工作区' });
  await panelCount(root, 2);
  await workspaceFilter.selectOption({ label: 'GUI 第二工作区' });
  await panelCount(root, 1);
  const allWorkspaces = await workspaceFilter.locator('option').first().getAttribute('value');
  await workspaceFilter.selectOption(allWorkspaces ?? '');
  await panelCount(root, 3);
  report.checks.push('Workspace selection joins the current native membership');

  await panelEntry(root, quiet.title).getByRole('checkbox').check();
  await panelEntry(root, sibling.title).getByRole('checkbox').check();
  await root.getByRole('button', { name: ui.restoreSelected }).waitFor({ state: 'visible' });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'));
  report.screenshots.light = await screenshot(page, paths, 'session-bin-light');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'));
  report.screenshots.dark = await screenshot(page, paths, 'session-bin-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await search.waitFor({ state: 'visible' });
  assert(await root.evaluate(element => element.getBoundingClientRect().width <= window.innerWidth + 1), 'Bin panel must fit the narrow viewport');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  report.narrowLayout = await root.evaluate(element => {
    const bounds = node => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }; };
    return { viewport: { width: innerWidth, height: innerHeight }, panel: bounds(element),
      controls: [...element.querySelectorAll('input,select,button')].map(node => ({ label: node.getAttribute('aria-label') || node.textContent, ...bounds(node) })) };
  });
  assert(report.narrowLayout.controls.every(control => control.right <= 391 && control.x >= 0), 'All narrow controls must fit horizontally');
  const narrowRestore = report.narrowLayout.controls.find(control => ui.restoreSelected.test(control.label ?? ''));
  assert(narrowRestore && narrowRestore.y >= 0 && narrowRestore.bottom <= 845, 'Batch restore must remain visible in the narrow viewport');
  report.screenshots.narrow = await screenshot(page, paths, 'session-bin-narrow');
  report.checks.push('Real host theme palettes and 390px layout render with selected batch controls');
  await page.setViewportSize({ width: 1440, height: 900 });
  await root.getByRole('button', { name: ui.restoreSelected }).click();
  await panelCount(root, 1);
  await panelEntry(root, prearchived.title).getByRole('button', { name: ui.restore }).click();
  await panelCount(root, 0);
  for (const item of [nativeOnly, prearchived]) {
    await eventually(async () => assert(await page.locator(`[data-row-key="session:${item.id}"]`).getAttribute('aria-description')),
      'Originally archived session remains natively archived');
  }
  report.checks.push('Batch Restore completes and an originally archived session stays archived');
  await page.reload();
  await keySetup.waitFor({ state: 'visible', timeout: 10000 });
  await keySetup.getByRole('button', { name: /^(?:稍后配置|Configure later)$/i }).click();
  await keySetup.waitFor({ state: 'hidden' });
  root = await panel(page);
  await panelCount(root, 0);
  report.checks.push('Full page reload reconstructs the packaged client and empty catalog');
}

async function main() {
  const parent = join(workspace, '.local', 'gui');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  scratch = await mkdtemp(join(parent, 'client-'));
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
    scratch, checks: [], screenshots: {}, limits: [], browserConsole: [], browserConsoleDetails: [], pageErrors: [],
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
      executablePath: executable, headless: true, locale: 'zh-CN', viewport: { width: 1440, height: 900 },
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
      executablePath: executable, headless: true, locale: 'zh-CN', viewport: { width: 1440, height: 900 }, env: environment,
      args: ['--no-proxy-server', '--disable-breakpad', '--disable-crash-reporter'],
    });
    const reloaded = browserContext.pages()[0] ?? await browserContext.newPage();
    reloaded.setDefaultTimeout(15000);
    await reloaded.goto(withoutBin.authenticatedUrl, { waitUntil: 'domcontentloaded' });
    await reloaded.waitForFunction(() => Array.isArray(window.__DSH_BOOT__?.entries));
    assert(!await reloaded.evaluate(() => window.__DSH_BOOT__.entries.some(entry => entry.id === 'dsh-session-bin')));
    const setupAgain = reloaded.getByRole('dialog', { name: /^(?:添加一个 API Key 开始使用|Add an API key to get started)$/i });
    await setupAgain.waitFor({ state: 'visible', timeout: 10000 });
    await setupAgain.getByRole('button', { name: /^(?:稍后配置|Configure later)$/i }).click();
    await setupAgain.waitFor({ state: 'hidden' });
    await reloaded.getByRole('button', { name: ui.viewOptions }).waitFor({ state: 'visible' });
    assert.equal(await reloaded.getByRole('button', { name: ui.panel }).count(), 0);
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
