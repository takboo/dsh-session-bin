import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { configuredNodeVersion, configuredPackageManager } from '../package-manager.mjs';
import { captureSources } from '../verification-sources.mjs';
import { compareVersions, FetchError, isWorkspaceInput, request, subprocessStatus } from './common.mjs';
import { candidateOverlay } from './candidate.mjs';
import { targetManifest } from './proposal.mjs';
import { discover } from './discover.mjs';
import { validateArchivePaths, validateDesktopRuntime, validateDesktopTarget, validateSignature } from './desktop-artifact.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
assert.equal(process.versions.node, await configuredNodeVersion(root));
assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
const parent = join(root, '.local/compatibility-desktop'); await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, 'darwin-arm64-'));
assert.equal((await statfs(scratch, { bigint: true })).type, 0x1an, 'Desktop candidate requires actual APFS');
const workspace = join(scratch, 'workspace');
const output = resolve(process.env.DSH_REPORT_DIR ?? join(scratch, 'report')); await mkdir(output, { recursive: true });
const baseline = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const before = await captureSources(root);
const report = { schema: 1, kind: 'desktop', status: 'running', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  platform: 'darwin', arch: 'arm64', filesystem: 'APFS', baselineSdk: baseline.engines.dsh, stages: [],
  productionAdmissionChanged: false, productionDeletionQualified: false, candidateChecksPassed: false,
  scope: 'Official signed macOS ARM64 ZIP/Electron; actual ASAR Host and native modules; isolated copied workspace and fixtures.',
  limits: ['Candidate evidence requires maintainer source review and a separate production admission change.',
    'Browser GUI uses published Web Host/client in the official Electron carrier, with ASAR Host verified separately; no native shell, physical IME or account/model inference claim.'] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const environment = { ...process.env, CI: 'true', DSH_HOME: join(scratch, 'dsh-home'), DSH_TELEMETRY_DISABLED: '1',
  DSH_COMPAT_BASELINE_SDK: baseline.engines.dsh, npm_config_ignore_scripts: 'true', PNPM_CONFIG_IGNORE_SCRIPTS: 'true' };
for (const key of Object.keys(environment)) if (/TOKEN|API_KEY|SECRET|PASSWORD|PRIVATE_KEY/.test(key)
  || ['NODE_OPTIONS', 'SSH_AUTH_SOCK', 'DSH_SNAPSHOT', 'DSH_PROFILE', 'DSH_WEB_URL', 'ELECTRON_RUN_AS_NODE',
    'DSH_SESSION_BIN_PLATFORM_VERIFY', 'DSH_SESSION_BIN_DESKTOP_VERIFY', 'DSH_SESSION_BIN_DESKTOP_SDK', 'DSH_SESSION_BIN_DESKTOP_APP'].includes(key)) delete environment[key];
class StageError extends Error { constructor(name, status) { super(`${name}: ${status}`); this.status = status; } }
async function command(name, file, args, { env = environment, cwd = workspace, setup = false, timeout = 15 * 60000 } = {}) {
  const chunks = []; let size = 0, timedOut = false, error;
  const result = await new Promise(done => {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = signal => { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') error ??= e; } };
    let force;
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 10000); }, timeout);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { size += bytes.length; if (size < 12 * 1024 * 1024) chunks.push(bytes); });
    child.once('error', e => { error = e; });
    child.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(force); done({ code, signal }); });
  });
  const log = Buffer.concat(chunks).toString('utf8').replace(/(token|password|authorization)\s*[=:]\s*[^\s]+/gi, '$1=[redacted]');
  await writeFile(join(output, name + '.log'), log);
  const status = subprocessStatus({ ...result, error, timedOut, setup, log });
  report.stages.push({ name, status, exitCode: result.code, signal: result.signal, timedOut }); await save();
  console.log(`${name}: ${status}`);
  if (status !== 'passed') throw new StageError(name, status);
  return log;
}
async function pnpm(name, args, options) { const pm = await configuredPackageManager(args); return command(name, pm.file, pm.args, options); }
async function collect(label) {
  for (const group of ['desktop', 'lifecycle', 'gui']) for (const entry of await readdir(join(workspace, '.local', group)).catch(() => [])) {
    const file = join(workspace, '.local', group, entry, 'verification.json');
    try { await access(file); } catch { continue; }
    const destination = join(output, label, group, entry); await mkdir(destination, { recursive: true }); await cp(file, join(destination, 'verification.json'));
  }
}
try {
  report.target = process.env.DSH_TARGET_JSON ? JSON.parse(process.env.DSH_TARGET_JSON) : (await discover({ manual: process.env.DSH_VERSION, local: true }))[0];
  report.version = report.target.version;
  const currentProbe = process.argv.includes('--current-baseline') && report.version === baseline.engines.dsh;
  assert(currentProbe || compareVersions(report.version, baseline.engines.dsh) > 0, 'Desktop verification cannot downgrade the baseline');
  if (currentProbe) report.limits.push('Verifier rehearsal on the existing baseline; not evidence for a future Desktop release.');
  const desktop = validateDesktopTarget(report.target);
  const metadata = await request(`https://registry.npmjs.org/@deepseek-ai%2Fdsh/${report.version}`);
  assert.equal(metadata.dist.integrity, report.target.npm.integrity, 'npm identity changed after discovery');
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(isWorkspaceInput);
  await mkdir(workspace);
  for (const path of paths) { await mkdir(dirname(join(workspace, path)), { recursive: true }); await cp(join(root, path), join(workspace, path), { dereference: false }); }
  const userconfig = join(scratch, 'empty-user.npmrc'), globalconfig = join(scratch, 'empty-global.npmrc');
  await Promise.all([writeFile(userconfig, ''), writeFile(globalconfig, '')]);
  Object.assign(environment, { npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, PNPM_CONFIG_USERCONFIG: userconfig, PNPM_CONFIG_GLOBALCONFIG: globalconfig });
  await pnpm('baseline-install', ['install', '--frozen-lockfile', '--ignore-scripts'], { setup: true });
  await pnpm('baseline-build', ['run', 'build']);
  const upgrade = join(scratch, 'upgrade.json');
  await command('upgrade-seed', process.execPath, ['scripts/compatibility/upgrade-worker.mjs', 'seed', upgrade]);
  const manifest = currentProbe ? baseline : targetManifest(baseline, report.version);
  await writeFile(join(workspace, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const policies = await readFile(join(workspace, 'pnpm-workspace.yaml'), 'utf8');
  await writeFile(join(workspace, 'pnpm-workspace.yaml'), policies.replaceAll(`@${baseline.engines.dsh}`, `@${report.version}`));
  await pnpm('target-lock', ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts'], { setup: true });
  await pnpm('target-install', ['install', '--frozen-lockfile', '--ignore-scripts'], { setup: true });
  await pnpm('normal-build', ['run', 'build']);
  const archive = join(scratch, 'official.zip');
  const sha512 = createHash('sha512'), sha256 = createHash('sha256'); let bytes = 0;
  let response;
  try { response = await fetch(desktop.path, { redirect: 'error', signal: AbortSignal.timeout(10 * 60000) }); }
  catch (error) { throw new FetchError(`Desktop download: ${error.message}`); }
  if (!response.ok) throw new FetchError(`Desktop download HTTP ${response.status}`);
  try { await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, done) {
    bytes += chunk.length; if (bytes > 2 * 1024 ** 3) return done(new Error('Desktop ZIP exceeds bounded size'));
    sha512.update(chunk); sha256.update(chunk); done(null, chunk);
  } }), createWriteStream(archive, { flags: 'wx' })); }
  catch (error) { throw new FetchError(`Incomplete Desktop download: ${error.message}`); }
  assert.equal(sha512.digest('base64'), desktop.sha512, 'Official Desktop ZIP integrity mismatch');
  report.artifact = { ...desktop, sha256: sha256.digest('hex'), bytes };
  const listing = await command('archive-list', '/usr/bin/tar', ['-tf', archive]);
  validateArchivePaths(listing.trim().split(/\r?\n/));
  const extracted = join(scratch, 'application'); await mkdir(extracted);
  // macOS libarchive keeps its default secure symlink/.. extraction protections.
  await command('archive-extract', '/usr/bin/tar', ['-xf', archive, '-C', extracted]);
  async function contained(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), canonical = await realpath(path);
      const rel = relative(extracted, canonical); assert(rel !== '..' && !rel.startsWith('..' + sep));
      if (entry.isDirectory()) await contained(path);
    }
  }
  await contained(extracted);
  const application = join(extracted, 'DeepSeek Harness.app');
  await command('signature-verify', '/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
  const signature = await command('signature-identity', '/usr/bin/codesign', ['-dv', '--verbose=4', application]); validateSignature(signature);
  const executable = join(application, 'Contents/MacOS/DeepSeek Harness');
  const sdkRoot = join(application, 'Contents/Resources/app.asar/dsh');
  const electron = { ...environment, ELECTRON_RUN_AS_NODE: '1', DSH_SESSION_BIN_DESKTOP_SDK: sdkRoot,
    NARB_NATIVE_CACHE_DIR: join(scratch, 'native-cache'), NARB_DISABLE_NATIVE_CACHE: '0' };
  const runtime = JSON.parse(await command('runtime-inspect', executable, ['--expose-internals', 'scripts/compatibility/inspect-desktop.mjs', sdkRoot], { env: electron }));
  validateDesktopRuntime(runtime, report.version); report.runtime = runtime; await save();
  const preload = ['--expose-internals', '--import', join(workspace, 'scripts/desktop-sdk-bootstrap.mjs')];
  await command('normal-asar-refusal', executable, [...preload, 'tests/helpers/desktop-refusal-worker.mjs'], { env: electron });
  await command('normal-electron-loader', executable, [...preload, 'scripts/verify-package.mjs'], { env: electron });
  await command('normal-electron-gui', executable, ['--expose-internals', 'scripts/verify-gui-locales.mjs'], { env: electron });
  await collect('normal');
  report.audit = await candidateOverlay({ workspace, baseline, targetVersion: report.version, output });
  await pnpm('candidate-build', ['run', 'build']);
  const carrier = { ...environment, DSH_SESSION_BIN_DESKTOP_APP: application };
  await pnpm('candidate-asar-suite', ['run', 'verify:desktop'], { env: carrier });
  await command('candidate-asar-upgrade', executable, [...preload, 'scripts/compatibility/upgrade-worker.mjs', 'verify', upgrade], { env: electron });
  await command('candidate-asar-loader', executable, [...preload, 'scripts/verify-package.mjs'], { env: electron });
  await pnpm('candidate-electron-gui', ['run', 'verify:desktop:gui'], { env: carrier });
  await collect('candidate');
  report.status = 'partial'; report.candidateChecksPassed = true;
  report.reason = 'Official signed Desktop candidate checks completed; production admission and PR draft state remain unchanged pending maintainer review.';
} catch (error) {
  report.status = error instanceof StageError ? error.status : error instanceof FetchError ? 'retry' : 'failed';
  report.reason = String(error.stack ?? error).slice(0, 5000);
} finally {
  await collect('evidence').catch(() => {});
  report.productionSourcesStable = before.sha256 === (await captureSources(root)).sha256;
  if (!report.productionSourcesStable) { report.status = 'failed'; report.reason = 'Production source inventory changed during Desktop verification'; }
  await save(); console.log(JSON.stringify(report, null, 2));
  process.exitCode = ['passed', 'partial'].includes(report.status) ? 0 : 1;
}
