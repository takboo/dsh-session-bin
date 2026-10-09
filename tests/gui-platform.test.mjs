import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { browserExecutableCandidates, selectReadableBrowser } from '../scripts/browser-executable.mjs';
import { isShutdownMessage, shutdownMessage } from '../scripts/gui-host-worker.mjs';

const worker = fileURLToPath(new URL('../scripts/gui-host-worker.mjs', import.meta.url));

function nextMessage(child, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for worker IPC.')), timeout);
    const onMessage = message => { if (predicate(message)) finish(null, message); };
    const onClose = (code, signal) => finish(new Error(`Worker closed before expected IPC (${code}, ${signal}).`));
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('close', onClose);
      if (error) reject(error); else resolve(value);
    };
    child.on('message', onMessage);
    child.once('close', onClose);
  });
}

test('browser candidates map each target OS and keep Edge behind Chrome/Chromium', () => {
  const windows = browserExecutableCandidates({ platform: 'win32', home: 'unused', env: {
    DSH_GUI_BROWSER_EXECUTABLE: 'D:\\Tools\\browser.exe',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  } });
  assert.deepEqual(windows[0], { path: 'D:\\Tools\\browser.exe', browser: 'configured', source: 'DSH_GUI_BROWSER_EXECUTABLE' });
  assert(windows.some(row => row.path === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
  assert(windows.some(row => row.path === 'C:\\Users\\tester\\AppData\\Local\\Chromium\\Application\\chrome.exe'));
  assert(windows.some(row => row.path === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'));
  assert(windows.findIndex(row => row.browser === 'edge') > windows.findLastIndex(row => row.browser === 'chromium'));

  const mac = browserExecutableCandidates({ platform: 'darwin', home: '/Users/tester', env: {} });
  assert(mac.some(row => row.path === '/Users/tester/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert(mac.findIndex(row => row.browser === 'edge') > mac.findLastIndex(row => row.browser === 'chromium'));

  const linux = browserExecutableCandidates({ platform: 'linux', home: '/home/tester', env: {} });
  assert.deepEqual(linux.slice(0, 4).map(row => row.path), [
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ]);
  assert(linux.findIndex(row => row.browser === 'edge') > linux.findLastIndex(row => row.browser === 'chromium'));
  assert.throws(() => browserExecutableCandidates({ platform: 'freebsd', env: {} }), /does not support platform/);
});

test('readable browser selection honors override order and reports every failed path', async () => {
  const candidates = [
    { path: '/configured', browser: 'configured', source: 'override' },
    { path: '/chrome', browser: 'chrome', source: 'system' },
    { path: '/edge', browser: 'edge', source: 'fallback' },
  ];
  const checked = [];
  const selected = await selectReadableBrowser(candidates, async path => {
    checked.push(path);
    if (path !== '/chrome') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  assert.equal(selected.path, '/chrome');
  assert.deepEqual(checked, ['/configured', '/chrome']);
  await assert.rejects(selectReadableBrowser(candidates, async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  }), error => error.code === 'DSH_GUI_BROWSER_NOT_FOUND'
    && error.failures.length === candidates.length && error.failures.every(row => row.code === 'EACCES'));
});

test('GUI worker accepts only the exact bounded shutdown message', () => {
  assert.equal(isShutdownMessage(shutdownMessage), true);
  for (const value of [null, 'SIGTERM', {}, { ...shutdownMessage, extra: true },
    { type: shutdownMessage.type, signal: 'SIGINT' }]) assert.equal(isShutdownMessage(value), false);
});

test('GUI worker emits SIGTERM inside a real Node child only after bounded IPC shutdown', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gui-worker-'));
  const cli = join(root, 'dummy-cli.mjs');
  await writeFile(cli, `export async function runCli() {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['web', '--no-open'])) throw new Error('worker argv mismatch');
  process.on('SIGTERM', () => {
    process.send?.({ type: 'dummy-sdk-sigterm' });
    setImmediate(() => process.exit(0));
  });
}\n`);
  const child = fork(worker, [cli, 'web', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  try {
    const ready = await nextMessage(child, message => message?.type === 'dsh-gui-host-cli-returned');
    assert(ready.sigtermListeners >= 1);
    child.send({ ...shutdownMessage, extra: 'not-accepted' });
    await delay(50);
    assert.equal(child.exitCode, null, 'An unbounded message must not stop the child');
    const delivered = nextMessage(child, message => message?.type === 'dsh-gui-host-shutdown-delivered');
    const sdkSignal = nextMessage(child, message => message?.type === 'dummy-sdk-sigterm');
    const closed = once(child, 'close');
    child.send(shutdownMessage);
    assert((await delivered).listeners >= 1);
    await sdkSignal;
    const [code, signal] = await closed;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
