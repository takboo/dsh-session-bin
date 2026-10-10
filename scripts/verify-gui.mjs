import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { WorkspaceRegistry, workspaceDomainSpec, workspaceDomainState, workspaceRecord } from '@deepseek-ai/dsh-workspace';
import { chromium } from 'playwright-core';
import { nativePlatformVerified, windowsSemaphoreName } from '../dist/index.js';
import { discoverBrowserExecutable } from './browser-executable.mjs';
import { shutdownMessage } from './gui-host-worker.mjs';
import { configuredPackageManager } from './package-manager.mjs';
import { workflowError } from './ci-diagnostics.mjs';

const require = createRequire(import.meta.url);
const workspace = fileURLToPath(new URL('../', import.meta.url));
const guiHostWorker = fileURLToPath(new URL('./gui-host-worker.mjs', import.meta.url));
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
    panel: '会话回收站', archive: '归档会话', nativeUnarchive: '取消归档', restore: '取消归档', undo: '撤销', search: '搜索归档',
    workspace: '工作区筛选', restoreSelected: '取消归档所选', refresh: '刷新', clearSelection: '取消选择',
    description: '管理原生归档，支持搜索、筛选、取消归档与明确确认的永久删除。', allWorkspaces: '所有工作区', ungrouped: '未分组',
    empty: '没有已归档的会话', emptyHint: '通过会话菜单中的原生归档将会话收起。',
    noMatches: '没有匹配的会话', noMatchesHint: '试试其他关键词或工作区。',
    selectAll: '选择当前显示的会话', entries: '已归档的会话',
    restored: '会话已取消归档', deleted: '会话已永久删除',
    deleteAction: title => `永久删除${title}`, deleteTitle: title => `永久删除“${title}”？`,
    confirmSetting: '永久删除会话前进行确认', stopBatch: '停止剩余删除',
    deleteConfirm: '确认永久删除', deleteCancel: '取消',
    deletionUnsupported: '当前宿主与存储组合暂不支持永久删除。',
    clearAllArchived: count => `清空全部归档（${count}）`, deleteSelected: '永久删除所选',
    batchSelectionTitle: count => `永久删除所选的 ${count} 个会话？`, batchAllTitle: count => `清空全部 ${count} 个归档会话？`,
    batchSummary: (total, executable, blocked) => `固定 ${total} 项 · 可执行 ${executable} 项 · 阻止 ${blocked} 项`,
    batchItems: '固定删除对象', batchConfirm: '删除可执行会话',
    batchCancelled: '批量删除已停止', batchDone: '批量删除已完成', dismissBatch: '关闭批次结果',
    count: count => `${count} 个会话`, selected: count => `已选 ${count} 项`, select: title => `选择 ${title}`,
    viewOptions: '视图选项', showArchived: '全部对话（显示已归档）', flat: '单列表',
    preview: '预览版说明', continue: '继续', keySetup: '添加一个 API Key 开始使用', configureLater: '稍后配置',
    settings: '设置', general: '通用设置', settingsClose: '关闭', languageLabel: '中文', htmlLanguage: 'zh-CN',
    plugins: '插件', openDetail: title => `查看 ${title}`,
    packageDescription: '管理原生归档，支持搜索、筛选、取消归档与明确确认的永久删除。',
  },
  en: {
    panel: 'Session Bin', archive: 'Archive session', nativeUnarchive: 'Unarchive session', restore: 'Unarchive', undo: 'undo', search: 'Search archives',
    workspace: 'Workspace filter', restoreSelected: 'Unarchive selected', refresh: 'Refresh', clearSelection: 'Clear selection',
    description: 'Manage native archives with search, filters, unarchive, and explicit permanent deletion.', allWorkspaces: 'All workspaces', ungrouped: 'Ungrouped',
    empty: 'No archived conversations', emptyHint: 'Use Archive in the conversation menu to collect conversations here.',
    noMatches: 'No matching conversations', noMatchesHint: 'Try another search or workspace.',
    selectAll: 'Select visible conversations', entries: 'Archived conversations',
    restored: 'Conversation unarchived', deleted: 'Conversation permanently deleted',
    deleteAction: title => `Permanently delete ${title}`, deleteTitle: title => `Permanently delete “${title}”?`,
    confirmSetting: 'Confirm before permanently deleting conversations', stopBatch: 'Stop remaining deletions',
    deleteConfirm: 'Delete permanently', deleteCancel: 'Cancel',
    deletionUnsupported: 'Permanent deletion is not supported by this Host and storage combination.',
    clearAllArchived: count => `Clear all archived (${count})`, deleteSelected: 'Permanently delete selected',
    batchSelectionTitle: count => `Permanently delete ${count} selected conversations?`, batchAllTitle: count => `Clear all ${count} archived conversations?`,
    batchSummary: (total, executable, blocked) => `${total} fixed · ${executable} executable · ${blocked} blocked`,
    batchItems: 'Fixed deletion targets', batchConfirm: 'Delete executable conversations',
    batchCancelled: 'Batch deletion stopped', batchDone: 'Batch deletion complete', dismissBatch: 'Dismiss batch results',
    count: count => `${count} ${count === 1 ? 'conversation' : 'conversations'}`,
    selected: count => `${count} selected`, select: title => `Select ${title}`,
    viewOptions: 'View options', showArchived: 'All conversations (show archived)', flat: 'In one list',
    preview: 'Preview Notice', continue: 'Continue', keySetup: 'Add an API key to get started', configureLater: 'Configure later',
    settings: 'Settings', general: 'General', settingsClose: 'Close', languageLabel: 'English', htmlLanguage: 'en',
    plugins: 'Plugins', openDetail: title => `View ${title}`,
    packageDescription: 'Manage native archives with search, filters, unarchive, and explicit permanent deletion.',
  },
};
let language = requestedLanguage;
let ui = copy[language];
const button = (root, name) => root.getByRole('button', { name, exact: true });
const menuItem = (root, name) => root.getByRole('menuitem', { name, exact: true });
const textbox = (root, name) => root.getByRole('textbox', { name, exact: true });
const text = (root, value) => root.getByText(value, { exact: true });
const children = new Set();
const guiHostWorkers = new WeakSet();
const guiHostWorkerState = new WeakMap();
const stoppingChildren = new WeakMap();
const cancellation = new AbortController();
let browserContext;
let scratch;
let activeHost;
const diagnosticTasks = new Set();
function observePage(page, report, stage) {
  page.on('pageerror', error => report.pageErrors.push(`${stage}: ${redact(error.message)}`));
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    report.browserConsole.push(`${stage}: ${redact(message.text())}`);
    if (report.browserConsole.length > 100) report.browserConsole.shift();
    const task = Promise.all(message.args().map(argument => argument.evaluate(value => {
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
    }))).then(details => report.browserConsoleDetails.push({ stage, details: JSON.parse(redact(JSON.stringify(details))) })).catch(() => {});
    diagnosticTasks.add(task);
    void task.finally(() => diagnosticTasks.delete(task));
  });
}
async function drainDiagnostics() { while (diagnosticTasks.size) await Promise.allSettled([...diagnosticTasks]); }

async function pluginDiagnostics(home) {
  const directory = join(home, 'profiles', 'web', '.plugin-manager', 'logs');
  let operations;
  try { operations = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const logs = [];
  for (const operation of operations) {
    if (!operation.isDirectory() || !operation.name.startsWith('operation-')) continue;
    const path = join(directory, operation.name, 'pnpm.log');
    try { logs.push({ operation: operation.name, output: redact((await readFile(path, 'utf8')).slice(-1024 * 1024)) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return logs;
}

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
function managedGuiHostWorker(cli, args, options) {
  cancellation.signal.throwIfAborted();
  const child = fork(guiHostWorker, [cli, ...args], {
    ...options, detached: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const state = { cliReturned: false, delivered: false, listeners: 0, error: null };
  guiHostWorkers.add(child);
  guiHostWorkerState.set(child, state);
  child.on('message', message => {
    if (message?.type === 'dsh-gui-host-cli-returned') state.cliReturned = true;
    if (message?.type === 'dsh-gui-host-shutdown-delivered') {
      state.delivered = true;
      state.listeners = message.listeners;
    }
    if (message?.type === 'dsh-gui-host-shutdown-error') state.error = { type: message.type, reason: message.reason };
    if (message?.type === 'dsh-gui-host-worker-error') state.error = { type: message.type, error: redact(message.error) };
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}
const COMMAND_OUTPUT_DRAIN_MS = 2000;
function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = error => { cleanup(); reject(error); };
    const onExit = (code, signal) => { cleanup(); resolve({ code, signal }); };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}
function streamDrained(stream) {
  if (!stream || stream.readableEnded || stream.closed || stream.destroyed) return Promise.resolve();
  return new Promise(resolve => {
    const cleanup = () => {
      stream.off('end', finish);
      stream.off('close', finish);
      stream.off('error', finish);
    };
    const finish = () => { cleanup(); resolve(); };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
  });
}
async function drainChildOutput(child, timeout = COMMAND_OUTPUT_DRAIN_MS) {
  const streams = [child.stdout, child.stderr].filter(Boolean);
  if (streams.length === 0) return;
  const drains = streams.map(streamDrained);
  let timer;
  const drained = await Promise.race([
    Promise.allSettled(drains).then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout); }),
  ]);
  clearTimeout(timer);
  if (drained) return;
  for (const stream of streams) stream.destroy();
  let closeTimer;
  await Promise.race([
    Promise.allSettled(drains),
    new Promise(resolve => { closeTimer = setTimeout(resolve, 1000); }),
  ]);
  clearTimeout(closeTimer);
}
function stopChild(child) {
  if (!child) return Promise.resolve({ code: null, signal: null, forced: false, delivery: 'none' });
  const existing = stoppingChildren.get(child);
  if (existing) return existing;
  const stopping = (async () => {
    const worker = process.platform === 'win32' && guiHostWorkers.has(child);
    const delivery = worker ? 'ipc-to-sdk-sigterm-handler' : 'os-sigterm';
    if (child.exitCode !== null || child.signalCode !== null) {
      await drainChildOutput(child);
      return { code: child.exitCode, signal: child.signalCode, forced: false, delivery };
    }
    const exit = exited(child);
    if (worker) {
      if (child.connected) child.send(shutdownMessage);
    } else {
      signalChild(child, 'SIGTERM');
    }
    let timer;
    const result = await Promise.race([
      exit,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 8000); }),
    ]);
    clearTimeout(timer);
    if (result) {
      await drainChildOutput(child);
      const state = guiHostWorkerState.get(child);
      return { ...result, forced: false, delivery, ...(state ? { worker: { ...state } } : {}) };
    }
    signalChild(child, 'SIGKILL');
    const forced = await exit;
    await drainChildOutput(child);
    return { ...forced, forced: true, delivery, ...(guiHostWorkerState.has(child) ? { worker: { ...guiHostWorkerState.get(child) } } : {}) };
  })();
  stoppingChildren.set(child, stopping);
  return stopping;
}
function recordHostShutdown(status, report, stage) {
  assert.equal(status.forced, false, 'Normal GUI verification must allow graceful Host disposal');
  assert.equal(status.code, 0, 'The public CLI shutdown handler must complete successfully');
  if (process.platform === 'win32') {
    assert.equal(status.delivery, 'ipc-to-sdk-sigterm-handler');
    assert.equal(status.worker?.delivered, true, 'Windows worker must deliver shutdown inside the child process');
    assert(status.worker.listeners >= 1, 'Windows worker must observe the SDK SIGTERM handler before delivery');
    assert.equal(status.worker.error, null);
  } else {
    assert.equal(status.delivery, 'os-sigterm', 'POSIX Host shutdown uses an OS signal to the isolated process group');
  }
  report.hostShutdown.push({ stage, ...status });
}
async function runCommand(command, args, options, label, timeout = 180000) {
  const child = managedSpawn(command, args, options);
  let output = '';
  let errors = '';
  const limit = 1024 * 1024;
  child.stdout.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-limit); });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors = (errors + chunk).slice(-limit); });
  let timer;
  try {
    const status = await Promise.race([
      exited(child),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); }),
    ]);
    clearTimeout(timer);
    if (status === null) {
      await stopChild(child);
      throw new Error(`${label} failed (timeout):\n${redact([output, errors].filter(Boolean).join('\n'))}`);
    }
    await drainChildOutput(child);
    if (status.code !== 0) {
      throw new Error(`${label} failed (exit ${status.code}, signal ${status.signal}):\n${redact([output, errors].filter(Boolean).join('\n'))}`);
    }
    return { stdout: output, stderr: errors };
  } finally { clearTimeout(timer); await stopChild(child); }
}
async function startHost(cli, environment, cwd, logName) {
  const args = ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'];
  const child = process.platform === 'win32'
    ? managedGuiHostWorker(cli, args, { cwd, env: environment })
    : managedSpawn(process.execPath, [cli, ...args], { cwd, env: environment });
  const host = { child, authenticatedUrl: undefined, cleanUrl: undefined, log: '', logName,
    shutdownDelivery: process.platform === 'win32' ? 'IPC delivered inside worker to SDK SIGTERM handler' : 'POSIX SIGTERM to isolated process group' };
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
async function readLogs(fixture, excluded = []) {
  const logs = {};
  for (const item of fixtures.filter(item => !excluded.includes(item.id))) {
    const handle = await fixture.ctx.sessionPersistence.open(SessionId(item.id), 'read');
    try { logs[item.id] = structuredClone(await handle.read()); }
    finally { await handle.close(); }
  }
  return logs;
}
async function physicalLogs(fixture, paths) {
  const root = await realpath(paths.sessions);
  const result = {};
  for (const item of fixtures) {
    const handle = await fixture.ctx.sessionPersistence.open(SessionId(item.id), 'read');
    let location;
    try { location = fixture.ctx.sessionPersistence.locate(handle.header); }
    finally { await handle.close(); }
    assert.equal(location.kind, 'jsonl');
    const canonicalArtifact = await realpath(location.path);
    const directory = await realpath(dirname(canonicalArtifact));
    ownsPath(root, directory);
    const directoryIdentity = await lstat(directory);
    const members = await readdir(directory, { withFileTypes: true });
    assert(members.every(member => member.isFile() && !member.isSymbolicLink()), 'GUI seed owns only regular JSONL artifacts and any POSIX stable lock');
    const lock = join(directory, 'session.lock');
    let coordination;
    if (process.platform === 'win32') {
      assert(!members.some(member => member.name === 'session.lock'), 'The audited Windows JSONL writer uses no session.lock file');
      coordination = { kind: 'win32-semaphore', name: windowsSemaphoreName(lock, 'session'), lockPath: lock };
    } else {
      const identity = await lstat(lock);
      assert(identity.isFile() && !identity.isSymbolicLink(), 'The POSIX writer lock must be a regular file');
      coordination = { kind: 'posix-lock-inode', path: lock,
        identity: { device: String(identity.dev), inode: String(identity.ino) } };
    }
    const files = [];
    for (const member of members.filter(member => process.platform === 'win32' || member.name !== 'session.lock').sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, member.name);
      files.push({ path, name: member.name, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    }
    assert(files.some(file => file.path === canonicalArtifact), 'Current seeded diagnostic artifact must physically exist');
    result[item.id] = { directory, directoryIdentity: { device: String(directoryIdentity.dev), inode: String(directoryIdentity.ino) }, files, coordination };
  }
  return result;
}
async function assertCoordinationIdentity(saved) {
  if (saved.coordination.kind === 'win32-semaphore') {
    await assert.rejects(access(saved.coordination.lockPath), error => error.code === 'ENOENT', 'Windows JSONL coordination must not gain a lock file');
    assert.equal(saved.coordination.name, windowsSemaphoreName(saved.coordination.lockPath, 'session'), 'Windows evidence must use the SDK writer semaphore path rule');
    return saved.coordination;
  }
  const identity = await lstat(saved.coordination.path);
  assert(identity.isFile() && !identity.isSymbolicLink(), 'Stable POSIX writer lock must remain a regular file');
  assert.deepEqual({ device: String(identity.dev), inode: String(identity.ino) }, saved.coordination.identity,
    'Permanent deletion must not replace or unlink the POSIX lock inode');
  return saved.coordination;
}
async function assertSavedTranscriptSha(saved, message = 'Unselected transcript bytes remain unchanged') {
  for (const file of saved.files) {
    assert.equal(createHash('sha256').update(await readFile(file.path)).digest('hex'), file.sha256, message);
  }
}
async function assertPhysicalDeletion(before, deletedSessionIds, report) {
  const deleted = new Set(deletedSessionIds);
  assert(deleted.size > 0 && [...deleted].every(id => fixtures.some(item => item.id === id)),
    'Deletion result must be the exact non-empty set of explicitly selected GUI fixtures');
  const evidence = [];
  for (const item of fixtures) {
    const saved = before[item.id];
    const directory = await lstat(saved.directory);
    assert(directory.isDirectory(), 'Permanent deletion must preserve the stable session directory');
    assert.deepEqual({ device: String(directory.dev), inode: String(directory.ino) }, saved.directoryIdentity, 'Session directory identity must remain stable');
    const coordination = await assertCoordinationIdentity(saved);
    for (const file of saved.files) {
      if (deleted.has(item.id)) await assert.rejects(access(file.path), error => error.code === 'ENOENT', 'Selected transcript bytes must physically disappear');
      else assert.equal(createHash('sha256').update(await readFile(file.path)).digest('hex'), file.sha256, 'Unselected transcript bytes remain unchanged');
    }
    if (deleted.has(item.id)) {
      assert.deepEqual((await readdir(saved.directory)).sort(), process.platform === 'win32' ? [] : ['session.lock'],
        'No transcript or unexpected successor survives selected deletion');
    }
    evidence.push({ sessionId: item.id, transcript: deleted.has(item.id) ? 'physically absent' : 'unchanged SHA-256',
      artifacts: saved.files.length, stableDirectory: true, coordination });
  }
  report.physicalDeletion = evidence;
}
async function assertPhysicalPreservation(before, report) {
  const evidence = [];
  for (const item of fixtures) {
    const saved = before[item.id];
    const directory = await lstat(saved.directory);
    assert(directory.isDirectory());
    assert.deepEqual({ device: String(directory.dev), inode: String(directory.ino) }, saved.directoryIdentity);
    const coordination = await assertCoordinationIdentity(saved);
    const expectedMembers = [...saved.files.map(file => file.name), ...(saved.coordination.kind === 'posix-lock-inode' ? ['session.lock'] : [])].sort();
    assert.deepEqual((await readdir(saved.directory)).sort(), expectedMembers,
      'Unsupported deletion and unarchive must neither remove nor publish physical artifacts');
    for (const file of saved.files) {
      assert.equal(createHash('sha256').update(await readFile(file.path)).digest('hex'), file.sha256,
        'An unsupported deletion attempt and later unarchive must preserve every transcript byte');
    }
    evidence.push({ sessionId: item.id, transcript: 'unchanged SHA-256', artifacts: saved.files.length,
      stableDirectory: true, coordination });
  }
  report.physicalPreservation = evidence;
}
function workspaceMembership(fixture) {
  return fixture.ctx.workspaceRegistry.list().map(workspace => ({ workspaceId: workspace.id, sessionIds: [...workspace.sessionIds] }));
}

async function readWorkspaceMembership(paths) {
  const ctx = new Context();
  let unit;
  try {
    await ctx.plugin(Storage);
    await ctx.plugin(storageJson, { root: paths.storages });
    unit = await ctx.storage.backend.get('json').kv.open({ name: workspaceDomainSpec.name, version: workspaceDomainSpec.version,
      tables: Object.keys(workspaceDomainSpec.tables), hasGlobal: true, layout: 'single' });
    const snapshot = await unit.loadAll(); // No Domain initialization, Registry, SessionStore, write, or Agent activation.
    const state = workspaceDomainState.parse(snapshot.global);
    assert(state.initialized && state.pendingMutation === undefined, 'Workspace snapshot must be committed and initialized');
    return state.workspaceIds.map(workspaceId => ({ workspaceId,
      sessionIds: [...workspaceRecord.parse(snapshot.tables.workspaces[workspaceId]).sessionIds] }));
  } finally { try { await unit?.close(); } finally { await ctx.fiber.dispose(); } }
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
async function archiveSession(page, id) {
  await rowMenu(page, id);
  assert.equal(await menuItem(page, 'Move to Session Bin').count(), 0);
  assert.equal(await menuItem(page, '移入回收站').count(), 0);
  await menuItem(page, ui.archive).click();
  await eventually(async () => assert(await page.locator(`[data-row-key="session:${id}"]`).getAttribute('aria-description')),
    'Native Archive updates the native row');
}
async function skipOptionalModelSetup(page) {
  const later = button(page, ui.configureLater);
  if (await later.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, error => {
    if (error.name === 'TimeoutError') return false;
    throw error;
  })) await later.click();
}
async function panel(page) {
  const search = textbox(page, ui.search);
  await button(page, ui.panel).waitFor({ state: 'visible' });
  if (!await search.isVisible()) await button(page, ui.panel).click();
  await search.waitFor({ state: 'visible' });
  return page.getByRole('region', { name: ui.panel, exact: true });
}
async function panelCount(root, count) {
  await eventually(async () => assert.equal(await root.getByRole('list', { name: ui.entries, exact: true }).getByRole('listitem').count(), count), 'Bin row count');
}
function panelEntry(root, title) {
  return root.getByRole('list', { name: ui.entries, exact: true }).getByRole('listitem').filter({ has: root.page().getByText(title, { exact: true }) });
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
async function assertNoArchiveDate(root) {
  assert.equal(await root.locator('time[datetime]').count(), 0,
    'Native archive set has no timestamp; observations must not be shown as archive dates');
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
  const clearAll = button(root, ui.clearAllArchived(count));
  await clearAll.waitFor({ state: 'visible' });
  assert.equal(await clearAll.isEnabled(), count > 0, 'Clear-all availability follows the complete archive collection');
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
    await root.getByRole('list', { name: ui.entries, exact: true }).first().waitFor({ state: 'visible' });
    await root.getByRole('checkbox', { name: ui.selectAll, exact: true }).waitFor({ state: 'visible' });
    await assertNoArchiveDate(root);
  }
  if (selectedCount) {
    await text(root, ui.selected(selectedCount)).waitFor({ state: 'visible' });
    await button(root, ui.clearSelection).waitFor({ state: 'visible' });
    await button(root, ui.deleteSelected).waitFor({ state: 'visible' });
    await button(root, ui.restoreSelected).waitFor({ state: 'visible' });
  } else {
    assert.equal(await button(root, ui.clearSelection).count(), 0);
  }
  return root;
}
async function switchLanguage(page, target, report) {
  const before = language;
  await page.locator('button[aria-haspopup="dialog"]').and(page.getByRole('button', { name: ui.settings, exact: true })).click();
  const currentDialog = page.getByRole('dialog', { name: ui.settings, exact: true });
  await currentDialog.waitFor({ state: 'visible' });
  await button(currentDialog, ui.general).click();
  // The shipped Language row uses the self-described catalog label as its
  // native menu anchor. The menu is portaled outside the Settings dialog.
  await button(currentDialog, ui.languageLabel).click();
  // LocaleRuntime publishes optimistically before ConfigFormController's
  // serialized Host write settles. A visible translated label is not a durable
  // preference receipt; await the actual locale mutation before any reload.
  const [saved] = await Promise.all([
    page.waitForResponse(response => {
      if (new URL(response.url()).pathname !== '/api/settings/mutate') return false;
      try { return Object.values(response.request().postDataJSON()?.payload?.args ?? {}).includes('locale'); }
      catch { return false; }
    }),
    menuItem(page, copy[target].languageLabel).click(),
  ]);
  const acknowledgement = await saved.json();
  assert.equal(acknowledgement.result?.ok, true, 'Host must acknowledge the language preference before reload');
  language = target;
  ui = copy[language];
  await assertDocumentLanguage(page);
  const translatedDialog = page.getByRole('dialog', { name: ui.settings, exact: true });
  await button(translatedDialog, ui.settingsClose).click();
  await translatedDialog.waitFor({ state: 'hidden' });
  await button(page, ui.panel).waitFor({ state: 'visible' });
  report.languageSwitches.push({ from: before, to: target, source: 'native Settings General Language menu' });
}
async function assertMenuCopy(page, id, archived) {
  const anchor = await rowMenu(page, id);
  const expected = archived ? ui.nativeUnarchive : ui.archive;
  await menuItem(page, expected).waitFor({ state: 'visible' });
  assert.equal(await menuItem(page, 'Move to Session Bin').count(), 0);
  assert.equal(await menuItem(page, '移入回收站').count(), 0);
  await menuItem(page, expected).focus();
  await page.keyboard.press('Escape');
  await eventually(async () => assert(await anchor.evaluate(element => element === document.activeElement)), 'Native menu returns focus');
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
function purgePlanSummary(plan) {
  const binding = plan?.binding;
  const manifest = plan?.manifest;
  const blockers = Array.isArray(plan?.blockers) ? plan.blockers.map(blocker => blocker.code) : [];
  const base = plan?.schemaVersion === 2 && plan?.action === 'purge' && typeof plan?.operationId === 'string'
    && plan.operationId.length > 0 && typeof plan?.sessionId === 'string' && plan.sessionId.length > 0
    && typeof plan?.expectedEntryId === 'string' && plan.expectedEntryId.length > 0;
  const scoped = Boolean(binding && manifest && binding.schemaVersion === 2 && binding.target === 'native-archive'
    && binding.entryId === plan.expectedEntryId && binding.lifecycle?.sessionId === plan.sessionId
    && manifest.lifecycle?.storeId === binding.lifecycle?.storeId
    && manifest.lifecycle?.sessionId === binding.lifecycle?.sessionId
    && manifest.lifecycle?.lifecycleId === binding.lifecycle?.lifecycleId
    && Array.isArray(manifest.resources) && manifest.resources.length > 0);
  const blockedWithoutScope = !binding && !manifest && blockers.length > 0;
  return { operationId: plan?.operationId ?? null, sessionId: plan?.sessionId ?? null,
    expectedEntryId: plan?.expectedEntryId ?? null, schemaVersion: plan?.schemaVersion ?? null,
    action: plan?.action ?? null, blockers, bound: Boolean(binding), frozen: Boolean(manifest),
    manifestResources: manifest?.resources?.length ?? 0,
    fixedRequestValid: Boolean(base && (scoped || blockedWithoutScope)) };
}
function ownerReceiptValid(result, execution) {
  const owner = result?.ownerState;
  return result?.status === 'success' && owner?.phase === 'done' && typeof owner.authorizationId === 'string'
    && owner.request?.operationId === execution.operationId
    && owner.request?.expected?.sessionId === execution.sessionId
    && owner.request?.bin?.entryId === execution.expectedEntryId
    && owner.resources?.length === execution.manifestResources
    && owner.resources.every(resource => resource.status !== 'failed');
}
async function confirmingBatchDialog(page, scope, count) {
  const title = scope === 'selection' ? ui.batchSelectionTitle(count) : ui.batchAllTitle(count);
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('list', { name: ui.batchItems, exact: true }).waitFor({ state: 'visible' });
  return dialog;
}
async function assertBatchConfirmation(dialog, targets, { executable, blocked }) {
  await text(dialog, ui.batchSummary(targets.length, executable, blocked)).waitFor({ state: 'visible' });
  const list = dialog.getByRole('list', { name: ui.batchItems, exact: true });
  await list.waitFor({ state: 'visible' });
  assert.equal(await list.getByRole('listitem').count(), targets.length, 'Batch modal must render the frozen target count');
  for (const target of targets) await text(list, target.title).waitFor({ state: 'visible' });
  await eventually(async () => assert(await button(dialog, ui.deleteCancel).evaluate(element => element === document.activeElement)),
    'Batch deletion initially focuses Cancel');
  return button(dialog, ui.batchConfirm);
}
async function dismissBatchResult(page, title) {
  await text(page, title).waitFor({ state: 'visible' });
  await button(page, ui.dismissBatch).click();
  await text(page, title).waitFor({ state: 'hidden' });
}
function observeDeletionRpc(page, report) {
  report.deletionPrepares = [];
  report.deletionExecutions = [];
  report.deletionSerial = { maxInFlight: 0, completedResponses: 0 };
  let activeExecutions = 0;
  const path = url => new URL(url).pathname;
  page.on('request', request => {
    if (path(request.url()) !== '/api/sessionBin/executePurge') return;
    try {
      const envelope = request.postDataJSON();
      const summary = purgePlanSummary(envelope.payload?.args?.plan);
      activeExecutions += 1;
      report.deletionSerial.maxInFlight = Math.max(report.deletionSerial.maxInFlight, activeExecutions);
      report.deletionExecutions.push({ ...summary, requestSequence: report.deletionExecutions.length + 1,
        responseStatus: null, ownerPhase: null, ownerReceiptValid: false });
    } catch (error) { report.deletionExecutions.push({ error: redact(error.message), fixedRequestValid: false }); }
  });
  page.on('response', response => {
    const responsePath = path(response.url());
    if (responsePath === '/api/sessionBin/executePurge') {
      activeExecutions = Math.max(0, activeExecutions - 1);
      report.deletionSerial.completedResponses += 1;
      const task = response.json().then(envelope => {
        const result = envelope.result?.ok ? envelope.result.value : null;
        const execution = report.deletionExecutions.find(row => row.operationId === result?.operationId);
        if (!execution) return;
        execution.responseStatus = result.status;
        execution.ownerPhase = result.ownerState?.phase ?? null;
        execution.authorizationId = result.ownerState?.authorizationId ?? null;
        execution.ownerReceiptValid = ownerReceiptValid(result, execution);
      }).catch(error => report.deletionExecutions.push({ responseError: redact(error.message), fixedRequestValid: false }));
      diagnosticTasks.add(task);
      void task.finally(() => diagnosticTasks.delete(task));
      return;
    }
    if (responsePath !== '/api/sessionBin/preparePurge') return;
    const task = response.json().then(envelope => {
      const result = envelope.result;
      if (!result?.ok) {
        report.deletionPrepares.push({ status: 'remote-error', code: result?.error?.code ?? null, fixedRequestValid: false }); return;
      }
      report.deletionPrepares.push({ status: 'prepared', ...purgePlanSummary(result.value) });
    }).catch(error => report.deletionPrepares.push({ status: 'diagnostic-error', error: redact(error.message), fixedRequestValid: false }));
    diagnosticTasks.add(task);
    void task.finally(() => diagnosticTasks.delete(task));
  });
}

async function runGui(page, paths, report, beforePhysical) {
  observeDeletionRpc(page, report);
  const [quiet, sibling, nativeOnly, prearchived] = fixtures;
  await page.waitForFunction(() => Array.isArray(window.__DSH_BOOT__?.entries));
  assert(await page.evaluate(() => window.__DSH_BOOT__.entries.some(entry => entry.id === '@takboo/dsh-session-bin')));
  await button(page, ui.panel).waitFor({ state: 'visible' });
  await assertDocumentLanguage(page);
  const preview = page.getByRole('dialog', { name: ui.preview, exact: true });
  await preview.waitFor({ state: 'visible', timeout: 10000 });
  await button(preview, ui.continue).click();
  await preview.waitFor({ state: 'hidden' });
  await skipModelSetup(page);
  await showAllSessions(page);
  let root = await assertPanelCopy(page, 2);
  for (const item of [nativeOnly, prearchived]) await text(root, item.title).waitFor({ state: 'visible' });
  report.checks.push('Preexisting native archives appear directly without a plugin Move action');
  report.coverage.push('native archived collection baseline', 'exact title/description/count/search/filter copy', 'absence of invented archive timestamps');

  await assertMenuCopy(page, quiet.id, false);
  await archiveSession(page, quiet.id);
  root = await assertPanelCopy(page, 3);
  const undo = button(page, ui.undo);
  await undo.waitFor({ state: 'visible' });
  assert.equal(await undo.count(), 1, 'Only native Archive provides Undo');
  await undo.click();
  root = await assertPanelCopy(page, 2);
  report.checks.push('Native Archive is the sole menu entry and its native Undo updates the plugin collection');
  report.coverage.push('native Archive/Undo', 'no plugin Move menu', 'native menu keyboard focus');

  await archiveSession(page, quiet.id);
  root = await assertPanelCopy(page, 3);
  await button(panelEntry(root, quiet.title), ui.restore).click();
  await assertToastCopy(page, ui.restored);
  root = await assertPanelCopy(page, 2);
  report.checks.push('Single unarchive removes the native mark and reports confirmed success');
  for (const item of [quiet, sibling]) await archiveSession(page, item.id);
  root = await assertPanelCopy(page, 4);
  for (const item of fixtures) await text(root, item.title).waitFor({ state: 'visible' });

  let search = textbox(root, ui.search);
  await search.fill('接口');
  root = await assertPanelCopy(page, 4, { visibleCount: 1, draft: '接口' });
  await text(root, sibling.title).waitFor({ state: 'visible' });
  await search.fill('no match 不存在 🧪');
  root = await assertPanelCopy(page, 4, { visibleCount: 0, draft: 'no match 不存在 🧪' });
  await search.fill('');
  await search.dispatchEvent('compositionstart', { data: '接' });
  await search.fill('接口');
  await panelCount(root, 4);
  await search.dispatchEvent('compositionend', { data: '接口' });
  await panelCount(root, 1);
  await search.press('Escape');
  assert.equal(await search.inputValue(), '');
  await panelCount(root, 4);
  await search.focus();
  await page.keyboard.press('Tab');
  assert(await root.evaluate(element => element.contains(document.activeElement)));
  report.checks.push('Search, no-matches, composition, Escape and Tab work in the selected language');
  report.coverage.push('metadata search', 'IME composition and keyboard focus');
  report.limits.push('Synthetic composition exercises browser handling, not a physical OS input-method session');
  const workspaceFilter = root.getByRole('combobox', { name: ui.workspace, exact: true });
  await workspaceFilter.selectOption({ label: fixtureWorkspaces.primary });
  await panelCount(root, 3);
  await workspaceFilter.selectOption({ label: fixtureWorkspaces.secondary });
  await panelCount(root, 1);
  await workspaceFilter.selectOption('all');
  await panelCount(root, 4);
  report.checks.push('Workspace filters use current native membership');
  assert.equal(await root.getByRole('region', { name: fixtureWorkspaces.primary, exact: true }).getByRole('listitem').count(), 3);
  assert.equal(await root.getByRole('region', { name: fixtureWorkspaces.secondary, exact: true }).getByRole('listitem').count(), 1);
  report.coverage.push('default workspace grouping');

  const choose = async () => {
    for (const item of [quiet, sibling]) await panelEntry(root, item.title).getByRole('checkbox', { name: ui.select(item.title), exact: true }).check();
    root = await assertPanelCopy(page, 4, { selectedCount: 2 });
  };
  await choose();
  await button(root, ui.clearSelection).click();
  root = await assertPanelCopy(page, 4);
  await choose();
  search = textbox(root, ui.search);
  await search.fill('接口');
  for (const target of ['en', 'zh']) {
    if (language !== target) await switchLanguage(page, target, report);
    root = await assertPanelCopy(page, 4, { visibleCount: 1, selectedCount: 2, draft: '接口' });
    assert.equal(await panelEntry(root, sibling.title).getByRole('checkbox', { name: ui.select(sibling.title), exact: true }).isChecked(), true);
    await assertMenuCopy(page, quiet.id, true);
    report.screenshots[`switched-${target}`] = await screenshot(page, paths, 'session-bin-language-switch');
  }
  report.checks.push('Native Settings updates translated controls while preserving selection, search draft and user titles');
  report.coverage.push('language switch and stable selection', 'no old archive-state badge');
  const hostPreference = requestedLanguage === 'zh' ? 'en' : 'zh';
  await switchLanguage(page, hostPreference, report);
  root = await panel(page);
  await button(root, ui.settings).click();
  await root.getByRole('checkbox', { name: ui.confirmSetting, exact: true }).uncheck();
  const executionsBeforeReload = report.deletionExecutions.length;
  await page.reload();
  await assertDocumentLanguage(page);
  await skipModelSetup(page);
  root = await assertPanelCopy(page, 4);
  await button(root, ui.settings).click();
  assert.equal(await root.getByRole('checkbox', { name: ui.confirmSetting, exact: true }).isChecked(), false);
  assert.equal(report.deletionExecutions.length, executionsBeforeReload, 'Persisted opt-out never deletes on reload');
  await root.getByRole('checkbox', { name: ui.confirmSetting, exact: true }).check();
  await button(root, ui.settings).click();
  report.coverage.push('global confirmation preference persists across reload without deletion');
  report.preferenceReload = { browserLocale, hostPreference, renderedHtmlLanguage: await page.locator('html').getAttribute('lang') };
  await switchLanguage(page, requestedLanguage, report);
  root = await assertPanelCopy(page, 4);
  report.checks.push('Host language preference survives refresh and overrides navigator');

  await choose();
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'));
  report.screenshots.light = await screenshot(page, paths, 'session-bin-light');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'));
  report.screenshots.dark = await screenshot(page, paths, 'session-bin-dark');
  await assertNarrowLayout(page, root, report);
  report.screenshots.narrow = await screenshot(page, paths, 'session-bin-narrow');
  await page.setViewportSize({ width: 1440, height: 900 });
  report.checks.push('Light, dark and 390px layouts keep all controls accessible');
  report.coverage.push('light/dark', '390px batch action');
  await button(root, ui.restoreSelected).click();
  root = await assertPanelCopy(page, 2);
  assert.equal(await text(root, quiet.title).count(), 0);
  assert.equal(await text(root, sibling.title).count(), 0);
  report.checks.push('Batch unarchive processes the fixed selection and leaves other archives intact');
  await button(panelEntry(root, prearchived.title), ui.restore).click();
  root = await assertPanelCopy(page, 1);
  await button(panelEntry(root, nativeOnly.title), ui.restore).click();
  root = await assertPanelCopy(page, 0);
  for (const item of fixtures) assert.equal(await page.locator(`[data-row-key="session:${item.id}"]`).getAttribute('aria-description'), null);
  report.checks.push('Preexisting archives unarchive normally and the empty collection shows native Archive guidance');
  report.coverage.push('single/batch unarchive', 'singular/plural/empty collection', 'native row convergence');

  await page.locator(`[data-row-key="session:${nativeOnly.id}"]`).getByText(nativeOnly.title, { exact: true }).click();
  await page.getByRole('tab').first().waitFor({ state: 'visible' });
  await page.locator('[contenteditable="true"],textarea').first().waitFor({ state: 'visible' });
  report.coverage.push('open native history before archive and permanent deletion');
  await archiveSession(page, nativeOnly.id);
  await skipOptionalModelSetup(page);
  root = await assertPanelCopy(page, 1);
  report.membershipBeforeDeletion = await readWorkspaceMembership(paths);
  await button(panelEntry(root, nativeOnly.title), ui.deleteAction(nativeOnly.title)).click();
  let deletion = page.getByRole('dialog', { name: ui.deleteTitle(nativeOnly.title), exact: true });
  await deletion.waitFor({ state: 'visible' });
  await eventually(async () => assert(await button(deletion, ui.deleteCancel).evaluate(element => element === document.activeElement)), 'Deletion initially focuses Cancel');
  assert.equal(await button(deletion, ui.deleteConfirm).isEnabled(), report.deletionQualification === 'supported');
  assert.equal(report.deletionExecutions.length, 0, 'Preparing a dialog never executes deletion');
  await button(deletion, ui.deleteCancel).click();
  await deletion.waitFor({ state: 'hidden' }); await panelCount(root, 1);
  assert.equal(report.deletionExecutions.length, 0, 'Cancel must never submit the destructive request');
  await button(panelEntry(root, nativeOnly.title), ui.restore).click();
  await assertPanelCopy(page, 0);
  await page.locator(`[data-row-key="session:${nativeOnly.id}"]`).getByText(nativeOnly.title, { exact: true }).click();
  await page.locator('[contenteditable="true"],textarea').first().waitFor({ state: 'visible' });
  await archiveSession(page, nativeOnly.id);
  await skipOptionalModelSetup(page);
  root = await assertPanelCopy(page, 1);
  report.coverage.push('cancel deletion, unarchive, reopen, and archive the released lifecycle again');
  await button(panelEntry(root, nativeOnly.title), ui.deleteAction(nativeOnly.title)).click();
  deletion = page.getByRole('dialog', { name: ui.deleteTitle(nativeOnly.title), exact: true });
  await deletion.waitFor({ state: 'visible' });
  const confirmButton = button(deletion, ui.deleteConfirm);
  await drainDiagnostics();
  assert.equal(report.deletionPrepares.length, 2, 'Cancelled and second dialogs prepare distinct explicit plans');
  assert.notEqual(report.deletionPrepares[0].operationId, report.deletionPrepares[1].operationId);
  if (report.deletionQualification === 'supported') {
    assert.equal(await confirmButton.isEnabled(), true, `Cold archived GUI target must be eligible: ${await deletion.innerText()}\n${JSON.stringify(report.deletionPrepares)}`);
    assert(report.deletionPrepares.every(plan => plan.status === 'prepared' && plan.fixedRequestValid && plan.schemaVersion === 2
      && plan.sessionId === nativeOnly.id && plan.expectedEntryId && plan.bound && plan.frozen && plan.blockers.length === 0),
    'Both qualified preparations bind the observed target and frozen owner scope');
    assert.equal(await button(deletion, ui.deleteConfirm).isEnabled(), true, await deletion.innerText());
    report.screenshots.deletion = await screenshot(page, paths, 'session-bin-permanent-delete');
    await button(deletion, ui.deleteConfirm).click();
    await assertToastCopy(page, ui.deleted);
    root = await assertPanelCopy(page, 0);
    await eventually(async () => assert.equal(await page.locator(`[data-row-key="session:${nativeOnly.id}"]`).count(), 0), 'Native row is removed after actual deletion');
    await drainDiagnostics();
    assert.equal(report.deletionExecutions.length, 1, 'Single explicit confirmation submits exactly one deletion');
    const confirmed = report.deletionPrepares[1];
    const execution = report.deletionExecutions[0];
    assert(execution.fixedRequestValid && execution.operationId === confirmed.operationId && execution.sessionId === nativeOnly.id
      && execution.expectedEntryId === confirmed.expectedEntryId && execution.responseStatus === 'success' && execution.ownerReceiptValid,
    'Single execution must reuse the prepared fixed request and finish with the actual SDK owner receipt');
    report.deletedSessionId = nativeOnly.id;
    report.deletedSessionIds.push(nativeOnly.id);
    report.singleDeletion = { scope: 'single', frozenCount: 1, cancelledExecutionCount: 0,
      confirmedExecutionCount: 1, ownerReceiptValid: execution.ownerReceiptValid };
    report.membershipAfterSingleDeletion = await readWorkspaceMembership(paths);
    const afterSingle = report.membershipBeforeDeletion.map(workspace => ({ ...workspace,
      sessionIds: workspace.sessionIds.filter(id => id !== nativeOnly.id) }));
    assert.deepEqual(report.membershipAfterSingleDeletion, afterSingle,
      'Only the single fixed target leaves the complete runtime Workspace account');
    report.checks.push('Qualified single deletion uses a frozen owner plan, explicit confirmation, Cancel focus and a complete owner receipt');
    report.coverage.push('single: fixed request and owner receipt', 'single: Cancel executes zero', 'single: native row removal');

    for (const item of [quiet, sibling]) await archiveSession(page, item.id);
    root = await assertPanelCopy(page, 2);
    for (const item of [quiet, sibling]) {
      await panelEntry(root, item.title).getByRole('checkbox', { name: ui.select(item.title), exact: true }).check();
    }
    root = await assertPanelCopy(page, 2, { selectedCount: 2 });
    const batchPrepareStart = report.deletionPrepares.length;
    const batchExecuteStart = report.deletionExecutions.length;
    await button(root, ui.deleteSelected).click();
    let batchDialog = await confirmingBatchDialog(page, 'selection', 2);
    await assertBatchConfirmation(batchDialog, [quiet, sibling], { executable: 2, blocked: 0 });
    await drainDiagnostics();
    let batchPlans = report.deletionPrepares.slice(batchPrepareStart);
    assert.equal(batchPlans.length, 2, 'The first selection modal prepares exactly its two fixed targets');
    assert.deepEqual(new Set(batchPlans.map(plan => plan.sessionId)), new Set([quiet.id, sibling.id]));
    assert(batchPlans.every(plan => plan.status === 'prepared' && plan.fixedRequestValid && plan.bound && plan.frozen
      && plan.blockers.length === 0), 'Each selected item must have a valid binding and frozen manifest');
    assert.equal(await button(batchDialog, ui.batchConfirm).isEnabled(), true, 'Explicit confirmation is available after qualification');
    assert.equal(report.deletionExecutions.length, batchExecuteStart, 'Unconfirmed selection batch executes nothing');
    await button(batchDialog, ui.deleteCancel).click();
    await batchDialog.waitFor({ state: 'hidden' });
    assert.equal(report.deletionExecutions.length, batchExecuteStart, 'Cancelled selection batch executes nothing');
    await dismissBatchResult(page, ui.batchCancelled);

    const confirmedBatchPrepareStart = report.deletionPrepares.length;
    await button(root, ui.deleteSelected).click();
    batchDialog = await confirmingBatchDialog(page, 'selection', 2);
    await assertBatchConfirmation(batchDialog, [quiet, sibling], { executable: 2, blocked: 0 });
    await drainDiagnostics();
    batchPlans = report.deletionPrepares.slice(confirmedBatchPrepareStart);
    assert.equal(batchPlans.length, 2, 'The confirmed selection batch freshly prepares both fixed targets');
    assert(batchPlans.every(plan => plan.fixedRequestValid && plan.bound && plan.frozen && plan.blockers.length === 0));
    assert.equal(await button(batchDialog, ui.batchConfirm).isEnabled(), true);
    report.screenshots.batchDeletion = await screenshot(page, paths, 'session-bin-batch-delete-confirmation');
    const releaseExecution = Promise.withResolvers();
    const firstExecutionFinished = Promise.withResolvers();
    let firstExecution = true;
    const holdFirstExecution = async route => {
      if (!firstExecution) { await route.continue(); return; }
      firstExecution = false;
      await releaseExecution.promise;
      try { await route.continue(); } finally { firstExecutionFinished.resolve(); }
    };
    await page.route('**/api/sessionBin/executePurge', holdFirstExecution);
    try {
      await button(batchDialog, ui.batchConfirm).click();
      await eventually(async () => assert.equal(firstExecution, false), 'First batch request enters the progress inspection gate');
      const progress = root.getByRole('region', { name: requestedLanguage === 'zh' ? '批量删除状态' : 'Batch deletion status', exact: true });
      await progress.getByRole('progressbar').waitFor({ state: 'visible' });
      await progress.getByRole('list', { name: ui.batchItems, exact: true }).waitFor({ state: 'visible' });
      await button(progress, ui.stopBatch).waitFor({ state: 'visible' });
      report.screenshots.batchProgress = await screenshot(page, paths, 'session-bin-batch-progress');
      report.coverage.push('in-progress batch has bounded progress, target logs and stop control');
    } finally {
      releaseExecution.resolve();
      if (!firstExecution) await firstExecutionFinished.promise;
      await page.unroute('**/api/sessionBin/executePurge', holdFirstExecution);
    }
    await text(page, ui.batchDone).waitFor({ state: 'visible' });
    report.screenshots.batchComplete = await screenshot(page, paths, 'session-bin-batch-complete');
    root = await assertPanelCopy(page, 0);
    await drainDiagnostics();
    const batchExecutions = report.deletionExecutions.slice(batchExecuteStart);
    assert.equal(batchExecutions.length, 2, 'Confirmed selection submits exactly two purge executions');
    assert.deepEqual(batchExecutions.map(item => item.operationId), batchPlans.map(item => item.operationId),
      'Selection execution reuses each freshly prepared request in fixed order');
    assert(batchExecutions.every(item => item.fixedRequestValid && item.responseStatus === 'success' && item.ownerReceiptValid),
      'Each selection target must finish with a complete actual SDK owner receipt');
    assert.equal(report.deletionSerial.maxInFlight, 1, 'Batch purge requests must execute strictly serially');
    report.batchDeletion = { scope: 'selection', frozenCount: 2, executable: 2, blocked: 0,
      cancelledExecutionCount: 0, confirmedExecutionCount: batchExecutions.length, strictSerialMaxInFlight: report.deletionSerial.maxInFlight };
    for (const item of [quiet, sibling]) {
      assert.equal(await page.locator(`[data-row-key="session:${item.id}"]`).count(), 0, 'Successfully deleted batch rows disappear from the native list');
      report.deletedSessionIds.push(item.id);
    }
    await assertSavedTranscriptSha(beforePhysical[prearchived.id],
      'The not-yet-selected prearchived transcript must keep its original SHA before clear-all');
    report.preClearUntouched = { sessionId: prearchived.id, transcript: 'unchanged SHA-256' };
    await dismissBatchResult(page, ui.batchDone);
    report.membershipAfterBatchDeletion = await readWorkspaceMembership(paths);
    const afterBatch = report.membershipBeforeDeletion.map(workspace => ({ ...workspace,
      sessionIds: workspace.sessionIds.filter(id => !new Set(report.deletedSessionIds).has(id)) }));
    assert.deepEqual(report.membershipAfterBatchDeletion, afterBatch,
      'Selection batch removes only its explicit fixed targets and retains any Host-created session');
    report.checks.push('Qualified batch deletion fixes two prepared identities and runs two actual owner operations strictly serially');
    report.coverage.push('batch: selection scope two', 'batch: Cancel and unconfirmed execute zero',
      'batch: strict serial owner success', 'batch: unselected SHA unchanged');

    await archiveSession(page, prearchived.id);
    root = await assertPanelCopy(page, 1);
    search = textbox(root, ui.search);
    await search.fill('原先');
    await root.getByRole('combobox', { name: ui.workspace, exact: true }).selectOption({ label: fixtureWorkspaces.primary });
    root = await assertPanelCopy(page, 1, { visibleCount: 0, draft: '原先' });
    const clearPrepareStart = report.deletionPrepares.length;
    const clearExecuteStart = report.deletionExecutions.length;
    await button(root, ui.clearAllArchived(1)).click();
    let clearDialog = await confirmingBatchDialog(page, 'all-archived', 1);
    await assertBatchConfirmation(clearDialog, [prearchived], { executable: 1, blocked: 0 });
    await drainDiagnostics();
    let clearPlans = report.deletionPrepares.slice(clearPrepareStart);
    assert.equal(clearPlans.length, 1);
    assert(clearPlans[0].fixedRequestValid && clearPlans[0].sessionId === prearchived.id
      && clearPlans[0].bound && clearPlans[0].frozen && clearPlans[0].blockers.length === 0,
    'Clear-all must prepare the complete hidden archive set, not only visible rows');
    assert.equal(await button(clearDialog, ui.batchConfirm).isEnabled(), report.deletionQualification === 'supported');
    report.screenshots.clearAll = await screenshot(page, paths, 'session-bin-clear-all-confirmation');
    assert.equal(report.deletionExecutions.length, clearExecuteStart, 'Unconfirmed clear-all executes nothing');
    await button(clearDialog, ui.deleteCancel).click();
    await clearDialog.waitFor({ state: 'hidden' });
    assert.equal(report.deletionExecutions.length, clearExecuteStart, 'Cancelled clear-all executes nothing');
    await dismissBatchResult(page, ui.batchCancelled);

    const confirmedClearPrepareStart = report.deletionPrepares.length;
    await button(root, ui.settings).click();
    await root.getByRole('checkbox', { name: ui.confirmSetting, exact: true }).uncheck();
    await button(root, ui.settings).click();
    await button(root, ui.clearAllArchived(1)).click();
    await text(page, ui.batchDone).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('dialog', { name: ui.batchAllTitle(1), exact: true }).count(), 0);
    clearPlans = report.deletionPrepares.slice(confirmedClearPrepareStart);
    assert.equal(clearPlans.length, 1);
    assert(clearPlans[0].fixedRequestValid && clearPlans[0].sessionId === prearchived.id
      && clearPlans[0].bound && clearPlans[0].frozen && clearPlans[0].blockers.length === 0);
    const compactResult = root.getByRole('region', { name: requestedLanguage === 'zh' ? '批量删除状态' : 'Batch deletion status', exact: true });
    assert.equal(await compactResult.getByRole('listitem').count(), 0, 'Successful completion does not keep a full target log');
    await button(root, ui.settings).click();
    await root.getByRole('checkbox', { name: ui.confirmSetting, exact: true }).check();
    await button(root, ui.settings).click();
    report.coverage.push('global opt-out deletes the prepared clear-all scope only on a fresh click', 'compact completion omits successful target logs');
    await drainDiagnostics();
    const clearExecutions = report.deletionExecutions.slice(clearExecuteStart);
    assert.equal(clearExecutions.length, 1, 'Confirmed clear-all submits its one complete hidden target');
    assert.equal(clearExecutions[0].operationId, clearPlans[0].operationId);
    assert(clearExecutions[0].fixedRequestValid && clearExecutions[0].responseStatus === 'success' && clearExecutions[0].ownerReceiptValid);
    report.clearAllDeletion = { scope: 'all-archived', frozenCount: 1, visibleCount: 0, executable: 1, blocked: 0,
      cancelledExecutionCount: 0, confirmedExecutionCount: clearExecutions.length };
    report.deletedSessionIds.push(prearchived.id);
    root = await assertPanelCopy(page, 0, { draft: '原先' });
    await dismissBatchResult(page, ui.batchDone);
    await textbox(root, ui.search).fill('');
    await root.getByRole('combobox', { name: ui.workspace, exact: true }).selectOption('all');
    root = await assertPanelCopy(page, 0);
    report.membershipAfterDeletion = await readWorkspaceMembership(paths);
    const deleted = new Set(report.deletedSessionIds);
    const afterAllDeletion = report.membershipBeforeDeletion.map(workspace => ({ ...workspace,
      sessionIds: workspace.sessionIds.filter(id => !deleted.has(id)) }));
    assert.deepEqual(report.membershipAfterDeletion, afterAllDeletion,
      'Clear-all removes only the last explicit fixture while every unrelated Host-created membership remains unchanged');
    assert.deepEqual(deleted, new Set(fixtures.map(item => item.id)), 'Qualified GUI flow must delete exactly the four seeded fixtures');
    assert(report.deletionPrepares.every(plan => plan.status === 'prepared' && plan.fixedRequestValid),
      'Every single, batch, and clear preparation must carry a legal fixed request');
    assert(report.deletionExecutions.every(item => item.fixedRequestValid && item.ownerReceiptValid),
      'Every destructive request must carry the fixed plan through a complete owner receipt');
    assert.equal(report.deletionSerial.completedResponses, report.deletionExecutions.length,
      'Every destructive request must receive exactly one observed response');
    report.checks.push('Qualified clear-all freezes the complete archive set despite hidden filters and erases after an explicit click with global confirmation disabled');
    report.coverage.push('clear: all-archived full set under visible zero', 'clear: Cancel executes zero',
      'clear: confirmed owner success', 'clear: unrelated Host membership retained');
  } else {
    const prepared = report.deletionPrepares;
    assert(prepared.every(plan => plan.status === 'prepared' && plan.fixedRequestValid && plan.schemaVersion === 2
      && plan.sessionId === nativeOnly.id && plan.expectedEntryId && plan.blockers.includes('permanent-deletion-unsupported')),
    'Each unqualified single preparation must explicitly report permanent-deletion-unsupported for the fixed observation');
    await text(deletion, ui.deletionUnsupported).waitFor({ state: 'visible' });
    assert.equal(await confirmButton.isEnabled(), false, 'Unsupported deletion confirmation must stay disabled');
    assert.equal(await button(deletion, ui.deleteConfirm).isEnabled(), false, 'Unsupported deletion execution must stay disabled');
    assert.equal(report.deletionExecutions.length, 0, 'Unsupported deletion must execute zero purge requests');
    report.screenshots.deletionUnsupported = await screenshot(page, paths, 'session-bin-deletion-unsupported');
    report.unsupportedModal = { blocker: 'permanent-deletion-unsupported', cancelInitiallyFocused: true,
      confirmDisabled: true, executeCount: 0 };
    await button(deletion, ui.deleteCancel).click();
    await deletion.waitFor({ state: 'hidden' });
    await button(panelEntry(root, nativeOnly.title), ui.restore).click();
    await assertToastCopy(page, ui.restored);
    root = await assertPanelCopy(page, 0);
    report.checks.push('Unqualified single deletion renders its blocker and executes zero requests before normal unarchive');
    report.coverage.push('single unsupported: blocker, disabled controls and zero execute');

    for (const item of [quiet, sibling]) await archiveSession(page, item.id);
    root = await assertPanelCopy(page, 2);
    for (const item of [quiet, sibling]) {
      await panelEntry(root, item.title).getByRole('checkbox', { name: ui.select(item.title), exact: true }).check();
    }
    root = await assertPanelCopy(page, 2, { selectedCount: 2 });
    const batchPrepareStart = report.deletionPrepares.length;
    await button(root, ui.deleteSelected).click();
    let batchDialog = await confirmingBatchDialog(page, 'selection', 2);
    const batchConfirmButton = await assertBatchConfirmation(batchDialog, [quiet, sibling], { executable: 0, blocked: 2 });
    await drainDiagnostics();
    const batchPlans = report.deletionPrepares.slice(batchPrepareStart);
    assert.equal(batchPlans.length, 2);
    assert(batchPlans.every(plan => plan.status === 'prepared' && plan.fixedRequestValid
      && plan.blockers.includes('permanent-deletion-unsupported')),
    'Unsupported selection must prepare both fixed targets as blocked M0 items');
    assert.equal(await batchConfirmButton.isEnabled(), false);
    assert.equal(await button(batchDialog, ui.batchConfirm).isEnabled(), false);
    assert.equal(report.deletionExecutions.length, 0);
    await button(batchDialog, ui.deleteCancel).click();
    await batchDialog.waitFor({ state: 'hidden' });
    await dismissBatchResult(page, ui.batchCancelled);
    assert.equal(report.deletionExecutions.length, 0, 'Unsupported selection cancel must keep execute count at zero');
    report.unsupportedBatch = { scope: 'selection', count: 2, executable: 0, blocked: 2, executeCount: 0 };
    await button(root, ui.clearSelection).click();
    root = await assertPanelCopy(page, 2);
    report.checks.push('Unqualified batch renders a fixed two-item M0 scope and Cancel sends no purge request');
    report.coverage.push('batch unsupported: scope two, M0, disabled confirmation and zero execute');

    await archiveSession(page, prearchived.id);
    root = await assertPanelCopy(page, 3);
    search = textbox(root, ui.search);
    await search.fill('原先');
    await root.getByRole('combobox', { name: ui.workspace, exact: true }).selectOption({ label: fixtureWorkspaces.primary });
    root = await assertPanelCopy(page, 3, { visibleCount: 0, draft: '原先' });
    const clearPrepareStart = report.deletionPrepares.length;
    await button(root, ui.clearAllArchived(3)).click();
    const clearDialog = await confirmingBatchDialog(page, 'all-archived', 3);
    const clearConfirmButton = await assertBatchConfirmation(clearDialog, [quiet, sibling, prearchived], { executable: 0, blocked: 3 });
    await drainDiagnostics();
    const clearPlans = report.deletionPrepares.slice(clearPrepareStart);
    assert.equal(clearPlans.length, 3, 'Unsupported clear-all must still prepare the complete hidden collection');
    assert.deepEqual(new Set(clearPlans.map(plan => plan.sessionId)), new Set([quiet.id, sibling.id, prearchived.id]));
    assert(clearPlans.every(plan => plan.status === 'prepared' && plan.fixedRequestValid
      && plan.blockers.includes('permanent-deletion-unsupported')));
    assert.equal(await clearConfirmButton.isEnabled(), false);
    assert.equal(await button(clearDialog, ui.batchConfirm).isEnabled(), report.deletionQualification === 'supported');
    assert.equal(report.deletionExecutions.length, 0);
    await button(clearDialog, ui.deleteCancel).click();
    await clearDialog.waitFor({ state: 'hidden' });
    await dismissBatchResult(page, ui.batchCancelled);
    report.unsupportedClear = { scope: 'all-archived', count: 3, visibleCount: 0, executable: 0, blocked: 3, executeCount: 0 };
    await textbox(root, ui.search).fill('');
    await root.getByRole('combobox', { name: ui.workspace, exact: true }).selectOption('all');
    root = await assertPanelCopy(page, 3);
    await root.getByRole('checkbox', { name: ui.selectAll, exact: true }).check();
    root = await assertPanelCopy(page, 3, { selectedCount: 3 });
    await button(root, ui.restoreSelected).click();
    root = await assertPanelCopy(page, 0);
    report.membershipAfterDeletionRefusal = await readWorkspaceMembership(paths);
    assert.deepEqual(report.membershipAfterDeletionRefusal, report.membershipBeforeDeletion,
      'Unsupported single, batch, clear and final unarchive preserve complete Workspace membership');
    assert.equal(report.deletionExecutions.length, 0, 'No unsupported scope may be mislabeled as a successful deletion');
    assert(report.deletionPrepares.every(plan => plan.status === 'prepared' && plan.fixedRequestValid));
    report.checks.push('Unqualified clear-all fixes all three entries while filters show zero, stays M0, then all entries unarchive normally');
    report.coverage.push('clear unsupported: all-archived hidden full set', 'clear unsupported: M0 and zero execute',
      'unsupported unified unarchive to empty');
  }

  for (const target of [requestedLanguage, requestedLanguage === 'zh' ? 'en' : 'zh']) {
    if (language !== target) await switchLanguage(page, target, report);
    await button(page, ui.plugins).click();
    await button(page, ui.openDetail(ui.panel)).click();
    const detail = page.locator('[data-plugin-detail="@takboo/dsh-session-bin"]');
    await detail.getByRole('heading', { name: ui.panel, level: 3, exact: true }).waitFor({ state: 'visible' });
    const description = detail.getByRole('paragraph').filter({ hasText: ui.packageDescription });
    await description.waitFor({ state: 'visible' });
    assert.equal(await description.textContent(), ui.packageDescription);
    report.metadata.push({ language: target, title: ui.panel, description: ui.packageDescription });
    await panel(page);
  }
  if (language !== requestedLanguage) await switchLanguage(page, requestedLanguage, report);
  await page.reload();
  await assertDocumentLanguage(page);
  await skipModelSetup(page);
  await assertPanelCopy(page, 0);
  report.membershipBeforeShutdown = await readWorkspaceMembership(paths);
  report.checks.push('Localized Plugins metadata and final archive state survive page reload');
}

async function main() {
  const parent = join(workspace, '.local', 'gui');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  scratch = await mkdtemp(join(parent, `client-${requestedLanguage}-`));
  ownsPath(await realpath(workspace), await realpath(scratch));
  const paths = {
    home: join(scratch, 'dsh-home'), primary: join(scratch, 'workspace'), secondary: join(scratch, 'second-workspace'),
    sessions: join(scratch, 'dsh-home', 'sessions'), storages: join(scratch, 'dsh-home', 'storages'),
    browser: join(scratch, 'browser-profile'), browserAfterUninstall: join(scratch, 'browser-after-uninstall'),
    artifacts: join(scratch, 'artifacts'), tmp: join(scratch, 'tmp'),
    userconfig: join(scratch, 'empty-user.npmrc'), globalconfig: join(scratch, 'empty-global.npmrc'),
  };
  await Promise.all([paths.home, paths.primary, paths.secondary, paths.artifacts, paths.tmp].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await Promise.all([writeFile(paths.userconfig, ''), writeFile(paths.globalconfig, '')]);
  const environment = {
    ...process.env, DSH_HOME: paths.home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write',
    CI: 'true', NO_UPDATE_NOTIFIER: '1',
    TMPDIR: paths.tmp, TMP: paths.tmp, TEMP: paths.tmp,
    XDG_CONFIG_HOME: join(scratch, 'xdg-config'), XDG_CACHE_HOME: join(scratch, 'xdg-cache'),
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
  const browserSelection = await discoverBrowserExecutable({ fallbackExecutable: chromium.executablePath() });
  const executable = browserSelection.path;
  // Linux singleton sockets must fit sockaddr_un even in long CI workspaces.
  const browserTmp = process.platform === 'linux' ? await mkdtemp('/tmp/dsh-gui-') : paths.tmp;
  const browserEnvironment = { ...environment, TMPDIR: browserTmp, TMP: browserTmp, TEMP: browserTmp };
  const browserConsole = [];
  const pageErrors = [];
  const deletionQualification = nativePlatformVerified() ? 'supported' : 'unsupported';
  const report = {
    status: 'running', sdk: expectedSdk, node: process.version, platform: process.platform, arch: process.arch,
    scratch, locale: browserLocale, requestedLanguage,
    deletionQualification,
    browserExecutable: browserSelection, isolatedTemporaryEnvironment: { TMPDIR: paths.tmp, TMP: paths.tmp, TEMP: paths.tmp },
    browserTemporaryEnvironment: { TMPDIR: browserTmp, TMP: browserTmp, TEMP: browserTmp },
    checks: [], coverage: [], languageSwitches: [], metadata: [], hostLaunches: [], hostShutdown: [],
    deletedSessionIds: [], screenshots: {}, limits: [], browserConsole, browserConsoleDetails: [], pageErrors,
    evidence: { deletionQualification, envBrowserConsole: browserConsole, pageErrors },
  };
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = paths.home;
  let beforeLogs;
  let beforePhysical;
  try {
    const fixture = await openSdkFixture(paths, true);
    try {
      beforeLogs = await readLogs(fixture);
      beforePhysical = await physicalLogs(fixture, paths);
      report.seedMembership = workspaceMembership(fixture);
    }
    finally { await fixture.close(); }
    const packCommand = await configuredPackageManager(['exec', 'npm', 'pack', '--json', '--ignore-scripts', '--offline',
      '--userconfig', paths.userconfig, '--globalconfig', paths.globalconfig,
      '--cache', join(scratch, 'npm-cache'), '--pack-destination', scratch]);
    const packed = await runCommand(packCommand.file, packCommand.args, {
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
      '--ignore-scripts', '--prefer-offline', `--store-dir=${store}`, `--cache-dir=${cache}`], {
      cwd: paths.primary, env: environment,
    }, 'Installing the tarball through dsh plugin');
    const profilePath = join(paths.home, 'profiles', 'web', 'package.json');
    const profile = JSON.parse(await readFile(profilePath, 'utf8'));
    assert(profile.dsh.profile.bundles.includes('@takboo/dsh-session-bin'), 'CLI installation must register the Bin bundle');
    report.checks.push('Public dsh plugin installs and activates the packed bundle in a new Web profile');
    const host = await startHost(cli, environment, paths.primary, 'host.log');
    report.hostLaunches.push({ stage: 'installed-host', cli, shutdownDelivery: host.shutdownDelivery });
    report.url = host.cleanUrl;
    browserContext = await chromium.launchPersistentContext(paths.browser, {
      executablePath: executable, headless: true, locale: browserLocale, viewport: { width: 1440, height: 900 },
      colorScheme: 'light', reducedMotion: 'reduce', env: browserEnvironment,
      args: ['--no-proxy-server', '--disable-breakpad', '--disable-crash-reporter'],
    });
    report.browser = browserContext.browser()?.version() ?? 'system Chrome';
    const page = browserContext.pages()[0] ?? await browserContext.newPage();
    page.setDefaultTimeout(15000);
    observePage(page, report, 'installed');
    await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(url => !url.searchParams.has('token'));
    assert.equal(new URL(page.url()).origin, new URL(host.cleanUrl).origin);
    await runGui(page, paths, report, beforePhysical);
    await drainDiagnostics();
    assert.deepEqual(report.pageErrors, [], `Unexpected browser errors: ${report.pageErrors.join('\n')}`);
    assert.deepEqual(report.browserConsole, [], `Unexpected browser warnings/errors: ${report.browserConsole.join('\n')}`);
    await browserContext.close();
    browserContext = undefined;
    const stopped = await stopChild(host.child);
    recordHostShutdown(stopped, report, 'installed-host');
    await writeFile(join(scratch, host.logName), host.log);
    activeHost = undefined;
    const after = await openSdkFixture(paths);
    try {
      if (report.deletionQualification === 'supported') {
        const deleted = new Set(report.deletedSessionIds);
        const expectedLogs = Object.fromEntries(Object.entries(beforeLogs).filter(([id]) => !deleted.has(id)));
        assert.deepEqual(await readLogs(after, report.deletedSessionIds), expectedLogs,
          'Every fixture outside the explicit deletion set keeps its original public SDK transcript');
        for (const sessionId of report.deletedSessionIds) {
          assert.equal(await after.ctx.sessionPersistence.stat(SessionId(sessionId)), undefined,
            `Explicitly deleted fixture ${sessionId} remains absent to the public SDK`);
        }
        await assertPhysicalDeletion(beforePhysical, report.deletedSessionIds, report);
        report.retainedWorkspaceSessionIds = report.membershipBeforeDeletion.flatMap(workspace => workspace.sessionIds)
          .filter(id => !deleted.has(id));
        report.checks.push('SDK reopen confirms all explicit single/batch/clear deletions, retained coordination identities and unchanged unrelated Workspace members');
        report.coverage.push('qualified all-deleted SDK reopen', 'deleted directories retained with stable coordination identity');
      } else {
        assert.deepEqual(await readLogs(after), beforeLogs, 'Unsupported deletion refusal and unarchive preserve every public SDK transcript');
        for (const item of fixtures) assert(await after.ctx.sessionPersistence.stat(SessionId(item.id)), `Fixture ${item.id} must remain readable after unsupported deletion`);
        await assertPhysicalPreservation(beforePhysical, report);
        report.checks.push('SDK reopen confirms unsupported deletion executed nothing and every original transcript byte remains');
        report.coverage.push('unsupported deletion SDK reopen', 'unsupported all-log byte preservation');
      }
      assert.deepEqual(workspaceMembership(after), report.membershipBeforeShutdown, 'Complete post-GUI Workspace membership remains durable after SDK reopen');
      const archived = after.ctx.workspaceRegistry.archivedSessionIds;
      assert.deepEqual(archived, [], 'Explicit unarchives and any qualified selected deletion remain durable after restart');
    } finally { await after.close(); }
    await runCommand(process.execPath, [cli, 'plugin', '--profile', 'web', 'remove', '@takboo/dsh-session-bin',
      `--store-dir=${store}`, `--cache-dir=${cache}`], { cwd: paths.primary, env: environment }, 'Uninstalling the test bundle');
    const removed = JSON.parse(await readFile(profilePath, 'utf8'));
    assert(!removed.dsh.profile.bundles.includes('@takboo/dsh-session-bin'));
    const withoutBin = await startHost(cli, environment, paths.primary, 'host-after-uninstall.log');
    report.hostLaunches.push({ stage: 'post-uninstall-host', cli, shutdownDelivery: withoutBin.shutdownDelivery });
    browserContext = await chromium.launchPersistentContext(paths.browserAfterUninstall, {
      executablePath: executable, headless: true, locale: browserLocale, viewport: { width: 1440, height: 900 }, env: browserEnvironment,
      args: ['--no-proxy-server', '--disable-breakpad', '--disable-crash-reporter'],
    });
    const reloaded = browserContext.pages()[0] ?? await browserContext.newPage();
    reloaded.setDefaultTimeout(15000);
    observePage(reloaded, report, 'after-uninstall');
    await reloaded.goto(withoutBin.authenticatedUrl, { waitUntil: 'domcontentloaded' });
    await reloaded.waitForFunction(() => Array.isArray(window.__DSH_BOOT__?.entries));
    assert(!await reloaded.evaluate(() => window.__DSH_BOOT__.entries.some(entry => entry.id === '@takboo/dsh-session-bin')));
    await assertDocumentLanguage(reloaded);
    await skipModelSetup(reloaded);
    await button(reloaded, ui.viewOptions).waitFor({ state: 'visible' });
    assert.equal(await button(reloaded, ui.panel).count(), 0);
    await browserContext.close();
    browserContext = undefined;
    const removedStopped = await stopChild(withoutBin.child);
    recordHostShutdown(removedStopped, report, 'post-uninstall-host');
    await writeFile(join(scratch, withoutBin.logName), withoutBin.log);
    activeHost = undefined;
    report.checks.push('Public CLI uninstall and a fresh true Web boot remove the client contribution');
    await drainDiagnostics();
    assert.deepEqual(report.pageErrors, [], 'Installed and uninstalled Web boots have no page errors');
    assert.deepEqual(report.browserConsole, [], 'Installed and uninstalled Web boots have no console warnings or errors');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = redact(error.stack ?? error);
    try { report.pluginDiagnostics = await pluginDiagnostics(paths.home); }
    catch (diagnosticError) { report.pluginDiagnosticError = redact(diagnosticError.message); }
    workflowError('GUI verification failed', [report.error,
      ...(report.pluginDiagnostics ?? []).map(log => `${log.operation}:\n${log.output}`)].join('\n'));
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
    if (browserTmp !== paths.tmp) await rm(browserTmp, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    await drainDiagnostics();
    const reportPath = join(scratch, 'verification.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
  }
}
function onInterrupt() {
  cancellation.abort(new Error('GUI verification was interrupted'));
  for (const child of children) void stopChild(child).catch(() => {});
  void browserContext?.close().catch(() => {});
}
if (import.meta.main) {
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try { await main(); }
  catch (error) { console.error(redact(error.stack ?? error)); process.exitCode = 1; }
  finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt); }
}

export { runCommand };
