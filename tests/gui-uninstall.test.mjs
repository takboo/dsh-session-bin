import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../scripts/verify-gui.mjs';
import { runObservedCli } from './helpers/gui-cli-worker.mjs';
import { configuredPackageManager } from '../scripts/package-manager.mjs';

const require = createRequire(import.meta.url);
const workspace = fileURLToPath(new URL('../', import.meta.url));
const cliWorker = fileURLToPath(new URL('./helpers/gui-cli-worker.mjs', import.meta.url));
const store = join(workspace, '.local', 'pnpm-store');
const cache = join(workspace, '.local', 'pnpm-cache');
const cli = require.resolve('@deepseek-ai/dsh/lib/bin.js');

function assertCommandClosed(result, label) {
  const output = result.stderr || result.stdout;
  assert.equal(result.naturalClose, true,
    `${label} did not close naturally within 8s; exit=${JSON.stringify(result.exit)}, close=${JSON.stringify(result.close)}\n${output}`);
  assert.deepEqual(result.exit && { code: result.exit.code, signal: result.exit.signal }, { code: 0, signal: null }, output);
  assert.deepEqual(result.close && { code: result.close.code, signal: result.close.signal }, { code: 0, signal: null }, output);
}

test('command completion follows CLI exit while draining inherited output', { timeout: 10000 }, async () => {
  const started = Date.now();
  const result = await runCommand(process.execPath, [cliWorker, 'hold-inherited-stdio', '4000'], {
    cwd: workspace,
    env: process.env,
  }, 'Inherited stdio fixture', 1000);
  assert(result.stdout.startsWith('cli-finished\n'));
  assert(result.stdout.includes('.'), 'The descendant must confirm accepted inherited output before the CLI exits');
  assert(Date.now() - started < 3000, 'The command must not wait for a retired descendant to close inherited stdio');
});

test('successful-looking output is not success before the CLI exits', { timeout: 5000 }, async () => {
  await assert.rejects(runCommand(process.execPath, [cliWorker, 'print-done-then-stall'], {
    cwd: workspace,
    env: process.env,
  }, 'Stalled CLI fixture', 300), error => error.message.includes('failed (timeout)')
    && error.message.includes('Done in 179ms using pnpm v11.7.0'));
});

test('failed commands retain diagnostics from both stdout and stderr with tokens redacted', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e',
    "process.stdout.write('ERR_PNPM_NO_OFFLINE_TARBALL https://example.invalid/?token=fixture-secret\\n'); process.stderr.write('dsh: plugin command failed\\n'); process.exitCode = 1;"],
  { cwd: workspace, env: process.env }, 'Dual-stream failure', 2000), error =>
    error.message.includes('ERR_PNPM_NO_OFFLINE_TARBALL') && error.message.includes('dsh: plugin command failed')
    && !error.message.includes('fixture-secret'));
});

test('public CLI add/remove fully exits in an isolated Web profile', {
  timeout: 30000,
}, async () => {
  const lifecycle = join(workspace, '.local', 'lifecycle');
  await mkdir(lifecycle, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(lifecycle, 'gui-uninstall-'));
  const home = join(root, 'dsh-home');
  const cwd = join(root, 'workspace');
  const tmp = join(root, 'tmp');
  const userconfig = join(root, 'empty-user.npmrc');
  const globalconfig = join(root, 'empty-global.npmrc');
  await Promise.all([home, cwd, tmp].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await Promise.all([writeFile(userconfig, ''), writeFile(globalconfig, '')]);
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: 'workspace-write',
    CI: 'true',
    NO_UPDATE_NOTIFIER: '1',
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_ignore_scripts: 'true',
    PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
    PNPM_CONFIG_UPDATE_NOTIFIER: 'false',
    PNPM_CONFIG_USERCONFIG: userconfig,
    PNPM_CONFIG_GLOBALCONFIG: globalconfig,
  };
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN',
    'DSH_SNAPSHOT', 'DSH_WEB_URL', 'DSH_PROFILE', 'NODE_OPTIONS']) delete env[key];

  try {
    const pack = await configuredPackageManager(['exec', 'npm', 'pack', '--json', '--ignore-scripts', '--offline',
      '--userconfig', userconfig, '--globalconfig', globalconfig, '--cache', join(root, 'npm-cache'), '--pack-destination', root]);
    const packed = await runCommand(pack.file, pack.args, { cwd: workspace, env }, 'Packing the current CLI fixture');
    const [metadata] = JSON.parse(packed.stdout);
    const tarball = join(root, metadata.filename);
    const add = await runObservedCli(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', tarball,
      '--ignore-scripts', '--prefer-offline', `--store-dir=${store}`, `--cache-dir=${cache}`], { cwd, env });
    assertCommandClosed(add, 'public plugin add');
    const profilePath = join(home, 'profiles', 'web', 'package.json');
    const installed = JSON.parse(await readFile(profilePath, 'utf8'));
    assert(installed.dsh.profile.bundles.includes('dsh-session-bin'));

    const remove = await runObservedCli(process.execPath, [cli, 'plugin', '--profile', 'web', 'remove', 'dsh-session-bin',
      `--store-dir=${store}`, `--cache-dir=${cache}`], { cwd, env });
    assertCommandClosed(remove, 'public plugin remove');
    const removed = JSON.parse(await readFile(profilePath, 'utf8'));
    assert(!removed.dsh.profile.bundles.includes('dsh-session-bin'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
