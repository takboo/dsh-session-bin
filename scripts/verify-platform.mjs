import { configuredPackageManager } from './package-manager.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
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
const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(command.file, command.args, { cwd: root, stdio: 'inherit',
    env: { ...process.env, DSH_SESSION_BIN_PLATFORM_VERIFY: '1' } });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
const final = await sources();
const stable = baseline.sha256 === final.sha256;
const report = { status: exitCode === 0 && stable ? 'passed' : 'failed', platform: process.platform, arch: process.arch,
  node: process.versions.node, libuv: process.versions.uv, sdk: manifest.engines.dsh, packageVersion: manifest.version,
  command: 'mise run verify:platform', exitCode, sourcesStable: stable, sourceSha256: baseline.sha256,
  scope: 'Actual OS kernel leases, frozen JSONL file erasure, resource owners, cache/SQLite, real process death and reopen, strict Remote/client regressions, and tarball loading on isolated sessions.',
  limits: 'The isolated composition qualifies an implemented candidate explicitly. This report alone does not enable production deletion or prove other architectures, filesystems, GUI/OS input methods, or power-loss durability.',
  scratch, sources: baseline.inventory };
await writeFile(join(scratch, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, sources: undefined }, null, 2));
process.exitCode = exitCode || (stable ? 0 : 1);
