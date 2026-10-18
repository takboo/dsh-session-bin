import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredNodeVersion } from './package-manager.mjs';
import { captureSources } from './verification-sources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.equal(process.versions.node, await configuredNodeVersion(root), 'Run the Desktop verification through mise.');
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const application = resolve(process.env.DSH_SESSION_BIN_DESKTOP_APP ?? '/Applications/DeepSeek Harness.app');
const executable = join(application, 'Contents/MacOS/DeepSeek Harness');
const sdkRoot = join(application, 'Contents/Resources/app.asar/dsh');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const parent = join(root, '.local/desktop');
await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, 'darwin-arm64-'));
const fs = await statfs(scratch, { bigint: true });
assert.equal(fs.type, 0x1an, 'Desktop qualification is restricted to APFS.');
const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1',
  DSH_HOME: join(scratch, 'dsh-home'), DSH_SESSION_BIN_DESKTOP_SDK: sdkRoot,
  NARB_NATIVE_CACHE_DIR: join(scratch, 'native-cache'), NARB_DISABLE_NATIVE_CACHE: '0' };
for (const key of ['NODE_OPTIONS', 'DSH_SESSION_BIN_DESKTOP_VERIFY', 'DSH_SESSION_BIN_PLATFORM_VERIFY',
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']) delete environment[key];
const baseline = await captureSources(root);
async function run(name, args, { capture = false } = {}) {
  let output = '';
  const status = await new Promise((resolveStatus, reject) => {
    const child = spawn(executable, ['--expose-internals', ...args], { cwd: root, env: environment,
      stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => { output += bytes; if (!capture) process.stdout.write(bytes); });
    let errors = '';
    child.stderr.on('data', bytes => { errors += bytes; process.stderr.write(bytes); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveStatus({ code, signal, errors }));
  });
  await writeFile(join(scratch, name + '.log'), output + status.errors);
  assert.equal(status.code, 0, `${name} failed; inspect ${join(scratch, name + '.log')}`);
  assert.equal(status.signal, null);
  return output;
}
const report = { status: 'running', sdk: manifest.engines.dsh, packageVersion: manifest.version,
  application, scratch, filesystem: { name: 'APFS', type: '0x1a' }, evidence: [],
  scope: 'Installed Electron carrier; actual ASAR Host/native modules; isolated sessions. Browser fixtures use published client artifacts.',
  limits: 'Only macOS ARM64, Electron 44.7.0 / Node 24.21.0 / libuv 1.52.1 on APFS. No native Desktop shell or physical OS input-method claim.' };
try {
  const preload = ['--import', join(root, 'scripts/desktop-sdk-bootstrap.mjs')];
  report.runtime = JSON.parse(await run('production-probe', [...preload, join(root, 'tests/helpers/desktop-runtime-worker.mjs')], { capture: true }));
  if (process.argv.includes('--gui')) {
    const guiRoot = join(root, '.local/gui');
    let old;
    try { old = new Set(await readdir(guiRoot)); } catch (error) { if (error.code !== 'ENOENT') throw error; old = new Set(); }
    await run('gui', [join(root, 'scripts/verify-gui-locales.mjs')]);
    for (const entry of await readdir(guiRoot)) if (!old.has(entry) && /^client-(zh|en)-/.test(entry)) {
      const path = join(guiRoot, entry, 'verification.json');
      const gui = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(gui.status, 'passed');
      assert.equal(gui.node, 'v24.21.0');
      assert.equal(gui.electron, '44.7.0');
      assert.equal(gui.deletionQualification, 'supported');
      assert.equal(gui.checks.length, 17);
      assert(gui.delayedHistoryRequests > 0);
      assert.equal(gui.historyReadiness?.length, 2);
      for (const opened of gui.historyReadiness) {
        assert.equal(opened.sessionId, 'gui-native-only');
        assert.deepEqual(opened.loadedTurns, [1, 2]);
        assert.equal(opened.nativeSidebar, true);
      }
      assert.deepEqual(gui.browserConsole, []);
      assert.deepEqual(gui.pageErrors, []);
      for (const shutdown of gui.hostShutdown) assert.deepEqual([shutdown.code, shutdown.signal, shutdown.forced], [0, null, false]);
      report.evidence.push({ path, locale: gui.locale, sha256: gui.sha256 });
    }
    assert.equal(report.evidence.length, 2);
    assert.equal(new Set(report.evidence.map(item => item.locale)).size, 2);
    assert.equal(new Set(report.evidence.map(item => item.sha256)).size, 1);
  } else {
    const tests = (await readdir(join(root, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(root, 'tests', name));
    const output = await run('tests', [...preload, '--test', '--test-concurrency=1', ...tests]);
    report.tests = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(name => {
      const match = new RegExp(`(?:ℹ |# )${name} (\\d+)`).exec(output);
      assert(match, `Missing ${name} test summary.`);
      return [name, Number(match[1])];
    }));
    assert.equal(report.tests.fail, 0);
    assert(report.tests.pass > 0);
  }
  const final = await captureSources(root);
  report.sourcesStable = final.sha256 === baseline.sha256;
  report.sourceSha256 = baseline.sha256;
  assert(report.sourcesStable);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1;
} finally {
  await writeFile(join(scratch, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, runtime: report.runtime && { ...report.runtime, sources: undefined } }, null, 2));
}
