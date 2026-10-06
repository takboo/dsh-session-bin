import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { parse } from 'yaml';
import { acquireBinLease } from '../dist/index.js';
import { createScratch, openFixture, workspaceRoot } from '../tests/helpers/fixture.mjs';

const exec = promisify(execFile);
const scratch = await createScratch('package-');
const userconfig = join(scratch, 'user.npmrc');
const globalconfig = join(scratch, 'global.npmrc');
await Promise.all([writeFile(userconfig, ''), writeFile(globalconfig, '')]);
const { stdout } = await exec('npm', ['pack', '--json', '--ignore-scripts', '--offline',
  '--userconfig', userconfig, '--globalconfig', globalconfig,
  '--cache', join(scratch, 'npm-cache'), '--pack-destination', scratch], { cwd: workspaceRoot });
const [pack] = JSON.parse(stdout);
const files = pack.files.map(file => file.path).sort();
assert(files.includes('dist/index.js') && files.includes('dist/index.d.ts'));
assert(files.includes('dist/operations.js') && files.includes('cordis.patch.yml'));
assert(files.includes('LICENSE') && files.includes('docs/host-lifecycle.md') && files.includes('docs/client-interface.md'));
assert(files.every(file => ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', 'docs/host-lifecycle.md', 'docs/client-interface.md'].includes(file)
  || file.startsWith('dist/')));
const tarball = join(scratch, pack.filename);
const installed = join(scratch, 'installed', 'node_modules', 'dsh-session-bin');
await mkdir(installed, { recursive: true });
await exec('tar', ['-xzf', tarball, '--strip-components=1', '-C', installed]);
const require = createRequire(join(installed, 'anchor.cjs'));
const manifest = JSON.parse(await readFile(require.resolve('dsh-session-bin/package.json'), 'utf8'));
assert.equal(manifest.version, '0.1.0-dev.0');
assert.equal(manifest.private, true);
assert.deepEqual(manifest.dsh.client, { platform: 'web' });
assert.equal(require.resolve('dsh-session-bin/client'), join(installed, 'dist/client.js'));
assert.equal(require.resolve('dsh-session-bin/remote'), join(installed, 'dist/remote.js'));
assert(files.includes('dist/client.js') && files.includes('dist/remote.js'));
const entryPath = require.resolve('dsh-session-bin');
assert.equal(entryPath, join(installed, 'dist/index.js'));
assert.equal(require.resolve('dsh-session-bin/operations'), join(installed, 'dist/operations.js'));
const packedRequire = createRequire(entryPath);
for (const [name, version] of Object.entries(manifest.peerDependencies)) {
  const manifestPath = await realpath(packedRequire.resolve(`${name}/package.json`));
  assert(!manifestPath.includes('/.local/dsh-runtime/'));
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).version, version);
}
const patch = parse(await readFile(join(installed, manifest.dsh.bundle.patch), 'utf8'));
assert.deepEqual(Object.keys(patch[0]), ['insert']);
assert.equal(patch[0].insert.length, 1);
const row = patch[0].insert[0];
assert.equal(row.name, manifest.name);
const fixture = await openFixture(scratch, { seed: true, plugin: false });
try {
  await fixture.mount(Loader, { baseUrl: pathToFileURL(join(scratch, 'installed') + '/').href });
  const id = await fixture.ctx.loader.create({ id: row.id, name: pathToFileURL(entryPath).href,
    config: { ...row.config, coordinationDirectory: join(scratch, 'coordination') } });
  await fixture.ctx.loader.await();
  const bin = fixture.ctx.get('sessionBin');
  assert(bin, 'packed Host Service must activate through the real Loader');
  const result = await bin.execute(await bin.prepare({ action: 'bin', sessionId: 'quiet' }));
  assert.equal(result.status, 'success');
  assert.equal((await bin.list()).length, 1);
  const fiber = fixture.ctx.loader.resolve(id).fiber;
  fixture.ctx.loader.remove(id);
  await fiber?.await();
  assert.equal(fixture.ctx.get('sessionBin'), undefined);
  assert.equal(fixture.ctx.storageDomain.get('session_bin'), undefined);
  const release = await acquireBinLease(join(scratch, 'coordination'));
  await release();
  // A second activation reopens the catalog; no duplicate service/listener remains.
  const again = await fixture.ctx.loader.create({ id: row.id, name: pathToFileURL(entryPath).href,
    config: { coordinationDirectory: join(scratch, 'coordination') } });
  await fixture.ctx.loader.await();
  assert.equal((await fixture.ctx.sessionBin.list()).length, 1);
  assert.equal((await fixture.ctx.sessionBin.execute(await fixture.ctx.sessionBin.prepare({ action: 'restore', sessionId: 'quiet' }))).status, 'success');
  const againFiber = fixture.ctx.loader.resolve(again).fiber;
  fixture.ctx.loader.remove(again);
  await againFiber?.await();
} finally { await fixture.close(); }
const report = {
  status: 'passed', tarball, sha256: createHash('sha256').update(await readFile(tarball)).digest('hex'),
  files, sdk: manifest.peerDependencies,
  scope: 'Packed public exports and bundle patch; real Cordis Loader activation, bin/restore, disposal and reactivation on temporary JSONL sessions.',
  limits: 'SDK dependencies supplied by the pinned repository install; not a clean profile/CLI install or a real GUI test.',
};
await writeFile(join(scratch, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
