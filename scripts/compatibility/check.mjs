import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSources } from '../verification-sources.mjs';
import { configuredNodeVersion, configuredPackageManager } from '../package-manager.mjs';
import { compareVersions, digest, FetchError, request, subprocessStatus, isWorkspaceInput, version } from './common.mjs';
import { targetManifest } from './proposal.mjs';
import { discover } from './discover.mjs';
import { candidateOverlay } from './candidate.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
assert.equal(process.versions.node, await configuredNodeVersion(root));
const parent = join(root, '.local', 'compatibility');
await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, `${process.platform}-${process.arch}-`));
const workspace = join(scratch, 'workspace');
const output = resolve(process.env.DSH_REPORT_DIR ?? join(scratch, 'report'));
await mkdir(output, { recursive: true });
const baseline = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const protectedFiles = ['src/host/native-retirement-sdk.ts', 'src/host/native-jsonl-files.ts', 'src/host/platform-files.ts'];
const protectedDigest = async () => digest(await Promise.all(protectedFiles.map(async path => [path, await readFile(join(root, path), 'utf8')])));
const before = await protectedDigest();
const report = { schema: 1, status: 'running', version: process.env.DSH_VERSION ?? '', baselineSdk: baseline.engines.dsh,
  platform: process.platform, arch: process.arch, node: process.versions.node, libuv: process.versions.uv,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
  stages: [], scratch, workspace, productionAdmissionChanged: false,
  scope: 'Exact SDK in isolated copied workspace; normal artifact refusal, test-only candidate lifecycle, upgrade and browser checks.',
  limits: ['Candidate results do not grant production deletion qualification.', 'No real user sessions, automatic merge, tag or publication.'] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
const environment = { ...process.env, CI: 'true', DSH_HOME: join(scratch, 'dsh-home'), DSH_TELEMETRY_DISABLED: '1',
  DSH_PERMISSION_MODE: 'workspace-write', npm_config_ignore_scripts: 'true', PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
  pnpm_config_verify_deps_before_run: 'error', pnpm_config_pm_on_fail: 'error' };
for (const key of Object.keys(environment)) if (/TOKEN|API_KEY|SECRET|PASSWORD|PRIVATE_KEY/.test(key) || ['NODE_OPTIONS', 'SSH_AUTH_SOCK', 'DSH_SNAPSHOT', 'DSH_PROFILE', 'DSH_WEB_URL', 'DSH_SESSION_BIN_PLATFORM_VERIFY', 'DSH_SESSION_BIN_DESKTOP_VERIFY', 'DSH_SESSION_BIN_DESKTOP_SDK'].includes(key)) delete environment[key];
class StageError extends Error { constructor(name, status) { super(`${name}: ${status}`); this.status = status; } }
async function command(name, file, args, { cwd = workspace, timeout = 12 * 60 * 1000, setup = false } = {}) {
  const chunks = []; let timedOut = false; let error;
  const result = await new Promise(resolveStatus => {
    const child = spawn(file, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    let size = 0;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
      size += bytes.length; if (size < 12 * 1024 * 1024) chunks.push(bytes);
    });
    child.once('error', e => { error = e; });
    child.once('close', (code, signal) => { clearTimeout(timer); resolveStatus({ code, signal }); });
  });
  const log = Buffer.concat(chunks).toString('utf8').replace(/(token|password|authorization)\s*[=:]\s*[^\s]+/gi, '$1=[redacted]');
  await writeFile(join(output, `${name}.log`), log);
  const status = subprocessStatus({ ...result, error, timedOut, setup, log });
  report.stages.push({ name, status, exitCode: result.code, signal: result.signal, timedOut }); await save();
  console.log(`${name}: ${status}`);
  if (status !== 'passed') throw new StageError(name, status);
}
async function pnpm(name, args, options) { const pm = await configuredPackageManager(args); await command(name, pm.file, pm.args, options); }
const validationErrors = [];
async function attempt(check) {
  try { await check(); }
  catch (error) { if (!(error instanceof StageError)) throw error; validationErrors.push({ status: error.status, reason: error.message }); }
}
async function collectReports(label) {
  for (const group of ['platform', 'lifecycle', 'gui']) {
    const directory = join(workspace, '.local', group);
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name, 'verification.json');
      let data;
      try { data = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
      const destination = join(output, label, group, entry.name);
      await mkdir(destination, { recursive: true }); await cp(path, join(destination, 'verification.json'));
      if (data.status !== 'passed' && group === 'gui') {
        const artifacts = join(directory, entry.name, 'artifacts');
        for (const name of await readdir(artifacts).catch(() => [])) if (/^[\w.-]+\.png$/.test(name)) {
          await cp(join(artifacts, name), join(destination, name));
        }
      }
    }
  }
}

try {
  report.target = process.env.DSH_TARGET_JSON ? JSON.parse(process.env.DSH_TARGET_JSON)
    : (await discover({ manual: version(report.version), local: true }))[0];
  report.version = version(report.target.version);
  assert(compareVersions(report.version, baseline.engines.dsh) > 0, 'Automatic updates must advance the baseline');
  if (!report.target.npm?.integrity) throw new FetchError('Target npm publication is incomplete; wait for matching package metadata.');
  const targetMetadata = await request(`https://registry.npmjs.org/@deepseek-ai%2Fdsh/${report.version}`);
  assert.equal(targetMetadata.dist.integrity, report.target.npm.integrity, 'Target identity changed during discovery');
  const tarball = await request(report.target.npm.tarball, { responseType: 'bytes' });
  const expectedIntegrity = /^sha512-([A-Za-z\d+/]+=*)$/.exec(report.target.npm.integrity);
  assert(expectedIntegrity && createHash('sha512').update(tarball).digest('base64') === expectedIntegrity[1], 'DSH tarball integrity mismatch');
  report.tarballSha256 = createHash('sha256').update(tarball).digest('hex');
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  await mkdir(workspace);
  for (const path of paths) {
    if (!isWorkspaceInput(path)) continue;
    await mkdir(dirname(join(workspace, path)), { recursive: true }); await cp(join(root, path), join(workspace, path), { dereference: false });
  }
  report.workspaceSourceSha256 = (await captureSources(workspace)).sha256; await save();
  const userconfig = join(scratch, 'empty-user.npmrc'), globalconfig = join(scratch, 'empty-global.npmrc');
  await Promise.all([writeFile(userconfig, '', { flag: 'wx' }), writeFile(globalconfig, '', { flag: 'wx' })]);
  Object.assign(environment, { npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
    PNPM_CONFIG_USERCONFIG: userconfig, PNPM_CONFIG_GLOBALCONFIG: globalconfig });
  await pnpm('baseline-install', ['install', '--frozen-lockfile', '--ignore-scripts'], { setup: true });
  await pnpm('baseline-build', ['run', 'build']);
  const upgradeManifest = join(scratch, 'upgrade.json');
  await command('upgrade-seed', process.execPath, ['scripts/compatibility/upgrade-worker.mjs', 'seed', upgradeManifest]);
  const manifest = targetManifest(baseline, report.version);
  await writeFile(join(workspace, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const policies = await readFile(join(workspace, 'pnpm-workspace.yaml'), 'utf8');
  await writeFile(join(workspace, 'pnpm-workspace.yaml'), policies.replaceAll(`@${baseline.engines.dsh}`, `@${report.version}`));
  await pnpm('target-lock', ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'], { setup: true });
  const proposal = {};
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) proposal[path] = await readFile(join(workspace, path), 'utf8');
  await writeFile(join(output, 'proposal.json'), JSON.stringify({ version: report.version, sourceCommit: report.sourceCommit, files: proposal }));
  await pnpm('target-install', ['install', '--frozen-lockfile', '--ignore-scripts'], { setup: true });
  const installed = createRequire(join(workspace, 'package.json'));
  report.resolved = {};
  for (const [name, expected] of Object.entries(manifest.devDependencies)) if (name.startsWith('@deepseek-ai/dsh')) {
    const actual = JSON.parse(await readFile(installed.resolve(`${name}/package.json`), 'utf8')).version;
    assert.equal(actual, expected); report.resolved[name] = actual;
  }
  await pnpm('target-types', ['run', 'check']);
  await pnpm('normal-build', ['run', 'build']);
  await pnpm('normal-loader-refusal', ['run', 'verify:package']);
  if (!process.argv.includes('--no-gui')) await attempt(() => pnpm('normal-gui-refusal', ['run', 'verify:gui']));
  await collectReports('normal');
  report.audit = await candidateOverlay({ workspace, baseline, targetVersion: report.version, output });
  await save();
  await pnpm('candidate-build', ['run', 'build']);
  await attempt(() => pnpm('candidate-platform', ['run', 'verify:platform']));
  await attempt(() => command('upgrade-verify', process.execPath, ['scripts/compatibility/upgrade-worker.mjs', 'verify', upgradeManifest]));
  if (!process.argv.includes('--no-gui')) await attempt(() => pnpm('candidate-gui', ['run', 'verify:gui']));
  await collectReports('candidate');
  report.status = validationErrors.some(e => e.status === 'failed') ? 'failed' : validationErrors.length ? 'retry' : 'partial';
  report.reason = validationErrors.length ? validationErrors.map(e => e.reason).join('; ') : 'Candidate checks completed; production admission unchanged. Source review and Desktop qualification remain separate.';
  if (process.argv.includes('--no-gui')) report.limits.push('Browser checks were explicitly omitted.');
  report.desktop = report.target.desktop ? 'available; requires separate official Electron/ASAR qualification' : 'waiting for matching official mac-arm64 feed';
} catch (error) {
  report.status = error instanceof StageError ? error.status : error instanceof FetchError ? 'retry' : 'failed';
  report.reason = String(error.stack ?? error).slice(0, 6000);
} finally {
  await collectReports('evidence').catch(error => { report.evidenceCollectionError = String(error); });
  report.productionSourcesStable = before === await protectedDigest();
  if (!report.productionSourcesStable) { report.status = 'failed'; report.reason = 'Protected production admission sources changed during the run'; }
  await save();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = ['passed', 'partial'].includes(report.status) ? 0 : 1;
}
