import { configuredPackageManager } from './package-manager.mjs';
import { workflowError, workflowNotice } from './ci-diagnostics.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(process.versions.node, manifest.engines.node, 'Platform verification must use the configured Node version.');
assert(process.env.npm_execpath, 'Run platform verification through its configured mise/pnpm task.');
assert(['win32', 'darwin', 'linux'].includes(process.platform), 'An actual supported OS runner is required.');
if (process.env.DSH_VERIFY_PLATFORM) assert.equal(process.platform, process.env.DSH_VERIFY_PLATFORM);
if (process.env.DSH_VERIFY_ARCH) assert.equal(process.arch, process.env.DSH_VERIFY_ARCH);
const parent = join(root, '.local', 'platform');
await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, `${process.platform}-${process.arch}-`));

async function capture(file, args, env = process.env) {
  let stdout = ''; let stderr = '';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, `${file} failed while identifying the verification filesystem: ${stderr.trim()}`);
  assert(stdout.trim(), `${file} returned no filesystem identity.`);
  return stdout.trim();
}

async function filesystemEvidence(path) {
  const stats = await statfs(path, { bigint: true });
  const name = process.platform === 'win32'
    ? await capture('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($env:DSH_SESSION_BIN_EVIDENCE_PATH)).DriveFormat'],
    { ...process.env, DSH_SESSION_BIN_EVIDENCE_PATH: path })
    : process.platform === 'darwin'
      ? await capture('stat', ['-f', '%T', path])
      : await capture('stat', ['-f', '-c', '%T', path]);
  return { name, type: `0x${stats.type.toString(16)}`, blockSize: stats.bsize.toString() };
}

async function sources() {
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  for (const path of ['src', 'tests', 'scripts', '.github']) await walk(join(root, path));
  for (const path of ['package.json', 'pnpm-lock.yaml', 'mise.toml', 'tsconfig.json', 'tsconfig.client.json']) files.push(join(root, path));
  const inventory = [];
  for (const path of files.sort()) inventory.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  inventory.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { inventory, sha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex') };
}
const baseline = await sources();
const command = await configuredPackageManager(['run', 'verify']);
let output = '';
const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(command.file, command.args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_SESSION_BIN_PLATFORM_VERIFY: '1' } });
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8').on('data', chunk => {
      output = (output + chunk).slice(-64 * 1024);
      destination.write(chunk);
    });
  }
  child.once('error', reject);
  child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
if (exitCode !== 0) {
  const failures = output.split('✖ failing tests:').at(-1).split(/\r?\n(?=test at )/).slice(1);
  for (const details of failures.length ? failures : [output.slice(-3500)]) {
    workflowError('Platform verification failed', details);
  }
}
const final = await sources();
const stable = baseline.sha256 === final.sha256;
const filesystem = await filesystemEvidence(scratch);
const report = { status: exitCode === 0 && stable ? 'passed' : 'failed', platform: process.platform, arch: process.arch,
  node: process.versions.node, libuv: process.versions.uv, sdk: manifest.engines.dsh, packageVersion: manifest.version,
  filesystem, command: 'mise run verify:platform', exitCode, sourcesStable: stable, sourceSha256: baseline.sha256,
  scope: 'Actual OS kernel leases, frozen JSONL file erasure, resource owners, cache/SQLite, real process death and reopen, strict Remote/client regressions, and tarball loading on isolated sessions.',
  limits: 'The isolated composition qualifies an implemented candidate explicitly. This report alone does not enable production deletion or prove other architectures, filesystems, GUI/OS input methods, or power-loss durability.',
  scratch, sources: baseline.inventory };
await writeFile(join(scratch, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, sources: undefined }, null, 2));
workflowNotice('Platform verification evidence', JSON.stringify({ status: report.status, platform: report.platform,
  arch: report.arch, node: report.node, libuv: report.libuv, sdk: report.sdk, filesystem: report.filesystem,
  sourceSha256: report.sourceSha256 }));
process.exitCode = exitCode || (stable ? 0 : 1);
