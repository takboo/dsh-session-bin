import { configuredPackageManager } from './package-manager.mjs';
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
import { SessionId } from '@deepseek-ai/dsh-session';
import { createScratch, openFixture, workspaceRoot } from '../tests/helpers/fixture.mjs';

const exec = promisify(execFile);
const scratch = await createScratch('package-');
const userconfig = join(scratch, 'user.npmrc');
const globalconfig = join(scratch, 'global.npmrc');
await Promise.all([writeFile(userconfig, ''), writeFile(globalconfig, '')]);
assert(process.env.npm_execpath, 'Run package verification through the configured mise/pnpm task.');
const packCommand = await configuredPackageManager(['exec', 'npm', 'pack', '--json', '--ignore-scripts', '--offline',
  '--userconfig', userconfig, '--globalconfig', globalconfig,
  '--cache', join(scratch, 'npm-cache'), '--pack-destination', scratch]);
const { stdout } = await exec(packCommand.file, packCommand.args, { cwd: workspaceRoot });
const [pack] = JSON.parse(stdout);
const files = pack.files.map(file => file.path).sort();
assert(files.includes('dist/index.js') && files.includes('dist/index.d.ts'));
assert(files.includes('dist/operations.js') && files.includes('cordis.patch.yml'));
assert(files.includes('LICENSE') && files.includes('docs/host-lifecycle.md') && files.includes('docs/client-interface.md'));
assert(files.includes('locale/en.json') && files.includes('locale/zh.json'));
assert(files.every(file => ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', 'docs/host-lifecycle.md', 'docs/client-interface.md', 'locale/en.json', 'locale/zh.json'].includes(file)
  || file.startsWith('dist/')));
const tarball = join(scratch, pack.filename);
const installed = join(scratch, 'installed', 'node_modules', '@takboo/dsh-session-bin');
await mkdir(installed, { recursive: true });
await exec('tar', ['-xzf', tarball, '--strip-components=1', '-C', installed]);
const require = createRequire(join(installed, 'anchor.cjs'));
const manifest = JSON.parse(await readFile(require.resolve('@takboo/dsh-session-bin/package.json'), 'utf8'));
const sourceManifest = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8'));
assert.equal(manifest.version, sourceManifest.version);
assert.notEqual(manifest.private, true, 'The verified package must be publishable.');
assert.equal(manifest.name, '@takboo/dsh-session-bin');
assert.deepEqual(manifest.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org' });
assert.equal(manifest.repository.url, 'git+https://github.com/takboo/dsh-session-bin.git');
assert.deepEqual(manifest.dsh.client, { platform: 'web' });
assert.equal(require.resolve('@takboo/dsh-session-bin/client'), join(installed, 'dist/client.js'));
assert.equal(require.resolve('@takboo/dsh-session-bin/remote'), join(installed, 'dist/remote.js'));
assert(files.includes('dist/client.js') && files.includes('dist/remote.js'));
for (const locale of ['en', 'zh']) {
  assert.equal(require.resolve(`@takboo/dsh-session-bin/locale/${locale}.json`), join(installed, 'locale', `${locale}.json`));
}
const sdkRequire = createRequire(import.meta.url);
const cliRequire = createRequire(sdkRequire.resolve('@deepseek-ai/dsh/package.json'));
const { readPluginMeta } = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
const localizedMeta = readPluginMeta('@takboo/dsh-session-bin', pathToFileURL(join(installed, 'anchor.mjs')).href);
assert.deepEqual(localizedMeta?.title, { en: 'Session Bin', zh: '会话回收站' });
assert.deepEqual(localizedMeta?.description, {
  en: 'Manage native archives with search, filters, unarchive, and explicit permanent deletion.',
  zh: '管理原生归档，支持搜索、筛选、取消归档与明确确认的永久删除。',
});
const entryPath = require.resolve('@takboo/dsh-session-bin');
assert.equal(entryPath, join(installed, 'dist/index.js'));
assert.equal(require.resolve('@takboo/dsh-session-bin/operations'), join(installed, 'dist/operations.js'));
assert(files.includes('dist/operations/index.d.ts') && files.includes('dist/operations/archive.d.ts'));
const operationContracts = await import(pathToFileURL(require.resolve('@takboo/dsh-session-bin/operations')).href);
assert(operationContracts.archivePlanSchema && operationContracts.planSchema, 'Packed operations export both v2 and legacy schemas');
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
const packedImplementation = await import(pathToFileURL(entryPath).href);
const productionDeletionQualified = packedImplementation.nativePlatformVerified();
const fixture = await openFixture(scratch, { seed: true, plugin: false });
try {
  await fixture.mount(Loader, { baseUrl: pathToFileURL(join(scratch, 'installed') + '/').href });
  const id = await fixture.ctx.loader.create({ id: row.id, name: pathToFileURL(entryPath).href,
    config: { ...row.config, coordinationDirectory: join(scratch, 'coordination') } });
  await fixture.ctx.loader.await();
  const bin = fixture.ctx.get('sessionBin');
  assert(bin, 'packed Host Service must activate through the real Loader');
  await fixture.ctx.workspaceRegistry.archiveSession(SessionId('quiet'));
  assert.equal((await bin.list()).length, 1);
  const fiber = fixture.ctx.loader.resolve(id).fiber;
  fixture.ctx.loader.remove(id);
  await fiber?.await();
  assert.equal(fixture.ctx.get('sessionBin'), undefined);
  assert.equal(fixture.ctx.storageDomain.get('session_bin'), undefined);
  assert.equal(fixture.ctx.storageDomain.get('session_bin_purge'), undefined);
  assert.equal(fixture.ctx.storageDomain.get('session_archive'), undefined);
  const release = await acquireBinLease(join(scratch, 'coordination'));
  await release();
  // A second activation reopens the catalog; no duplicate service/listener remains.
  const again = await fixture.ctx.loader.create({ id: row.id, name: pathToFileURL(entryPath).href,
    config: { coordinationDirectory: join(scratch, 'coordination') } });
  await fixture.ctx.loader.await();
  assert.equal((await fixture.ctx.sessionBin.list()).length, 1);
  assert.equal((await fixture.ctx.sessionBin.execute(await fixture.ctx.sessionBin.prepare({ action: 'unarchive', sessionId: 'quiet' }))).status, 'success');
  await fixture.ctx.workspaceRegistry.archiveSession(SessionId('sibling'));
  const purge = await fixture.ctx.sessionBin.preparePurge({ sessionId: 'sibling' });
  if (productionDeletionQualified) {
    assert.deepEqual(purge.blockers, [], 'Packed owner must qualify the actual pinned JSONL composition.');
    assert.equal((await fixture.ctx.sessionBin.executePurge(purge)).status, 'success');
    assert.equal(await fixture.ctx.sessionPersistence.stat(SessionId('sibling')), undefined);
  } else {
    assert(purge.blockers.some(item => item.code === 'permanent-deletion-unsupported'));
    assert.equal((await fixture.ctx.sessionBin.executePurge(purge)).status, 'rejected');
    assert(await fixture.ctx.sessionPersistence.stat(SessionId('sibling')), 'Unqualified production must retain the transcript.');
  }
  const againFiber = fixture.ctx.loader.resolve(again).fiber;
  fixture.ctx.loader.remove(again);
  await againFiber?.await();
} finally { await fixture.close(); }
const report = {
  status: 'passed', tarball, sha256: createHash('sha256').update(await readFile(tarball)).digest('hex'),
  files, sdk: manifest.peerDependencies,
  platform: process.platform, arch: process.arch, node: process.versions.node, productionDeletionQualified,
  scope: `Packed public exports and bundle patch; real Cordis Loader activation, native archive/unarchive, ${productionDeletionQualified ? 'actual single-conversation JSONL deletion' : 'explicit unsupported deletion with transcript preservation'}, disposal and reactivation on temporary sessions.`,
  limits: 'SDK dependencies supplied by the pinned repository install; not a clean profile/CLI install or a real GUI test.',
};
await writeFile(join(scratch, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
