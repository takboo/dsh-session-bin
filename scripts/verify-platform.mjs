import { filesystemEvidence } from './filesystem-evidence.mjs';
import { captureSources } from './verification-sources.mjs';
import { configuredNodeVersion, configuredPackageManager } from './package-manager.mjs';
import { workflowError, workflowNotice } from './ci-diagnostics.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(process.versions.node, await configuredNodeVersion(root), 'Platform verification must use the configured Node build version.');
assert(process.env.npm_execpath, 'Run platform verification through its configured mise/pnpm task.');
assert(['win32', 'darwin', 'linux'].includes(process.platform), 'An actual supported OS runner is required.');
if (process.env.DSH_VERIFY_PLATFORM) assert.equal(process.platform, process.env.DSH_VERIFY_PLATFORM);
if (process.env.DSH_VERIFY_ARCH) assert.equal(process.arch, process.env.DSH_VERIFY_ARCH);
const parent = join(root, '.local', 'platform');
await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, `${process.platform}-${process.arch}-`));


const baseline = await captureSources(root);
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
const final = await captureSources(root);
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
