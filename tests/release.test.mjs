import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRelease, releaseTag, verifyRelease } from '../scripts/release.mjs';

const commit = 'a'.repeat(40);
const manifest = { name: '@takboo/dsh-session-bin', version: '0.1.0-rc.1', engines: { dsh: '0.2.0-rc.2', node: '24.18.1' } };
const ref = `refs/tags/v${manifest.version}`;
const hash = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('the exact tested package payload');
  const common = { status: 'passed', platform: 'linux', arch: 'x64', node: '24.18.1' };
  const records = {
    platform: { ...common, packageVersion: manifest.version, sdk: manifest.engines.dsh,
      sourcesStable: true, exitCode: 0, libuv: '1.52.1', sourceSha256: 'b'.repeat(64), filesystem: { name: 'ext2/ext3/ext4' } },
    loader: { ...common, productionDeletionQualified: true },
    zh: { ...common, node: 'v24.18.1', locale: 'zh-CN', sdk: manifest.engines.dsh, deletionQualification: 'supported' },
    en: { ...common, node: 'v24.18.1', locale: 'en-US', sdk: manifest.engines.dsh, deletionQualification: 'supported' },
  };
  const locations = { platform: ['platform', 'linux-x64-fixture'], loader: ['lifecycle', 'package-fixture'],
    zh: ['gui', 'client-zh-fixture'], en: ['gui', 'client-en-fixture'] };
  const paths = {};
  for (const [key, parts] of Object.entries(locations)) {
    const directory = join(root, '.local', ...parts);
    await mkdir(directory, { recursive: true });
    paths[key] = join(directory, 'verification.json');
    if (key !== 'platform') {
      records[key].tarball = join(directory, 'fixture.tgz');
      records[key].sha256 = hash(bytes);
      await writeFile(records[key].tarball, bytes);
    }
    await writeFile(paths[key], JSON.stringify(records[key]));
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  const options = { root, output: join(root, '.local', 'release'), commit, ref, repository: 'takboo/dsh-session-bin' };
  return { options, paths, records, bytes };
}

test('only matching SemVer tags are releases, and prereleases are classified correctly', () => {
  assert.deepEqual(releaseTag(manifest, ref), { tag: 'v0.1.0-rc.1', prerelease: true });
  assert.equal(releaseTag({ version: '1.2.3+build.4' }, 'refs/tags/v1.2.3+build.4').prerelease, false);
  for (const invalid of ['refs/heads/v0.1.0-rc.1', 'refs/tags/v0.1.0', 'refs/tags/v9.9.9']) {
    assert.throws(() => releaseTag(manifest, invalid));
  }
  for (const version of ['01.2.3', '1.2.3-01', '1.2', '1.2.3-', '1.2.3+']) {
    assert.throws(() => releaseTag({ version }, `refs/tags/v${version}`));
  }
});

test('the release payload preserves tested bytes and carries verifiable commit metadata', async t => {
  const { options, bytes } = await fixture(t);
  const metadata = await prepareRelease(options);
  assert.deepEqual(await readFile(join(options.output, 'dsh-session-bin.tgz')), bytes);
  assert.equal(metadata.package, manifest.name);
  const sums = await readFile(join(options.output, 'SHA256SUMS'), 'utf8');
  for (const line of sums.trim().split('\n')) {
    const [expected, filename] = line.split('  ');
    assert.equal(hash(await readFile(join(options.output, filename))), expected);
  }
  assert.equal((await verifyRelease({ ...options, manifest })).prerelease, true);
});

test('failed, unsupported, stale, or mismatched evidence cannot produce release assets', async t => {
  for (const [name, mutate] of [
    ['failed GUI', f => { f.records.zh.status = 'failed'; }],
    ['unsupported GUI deletion', f => { f.records.en.deletionQualification = 'unsupported'; }],
    ['unsupported Loader deletion', f => { f.records.loader.productionDeletionQualified = false; }],
    ['changed sources', f => { f.records.platform.sourcesStable = false; }],
    ['different version', f => { f.records.platform.packageVersion = '9.0.0'; }],
    ['different runtime', f => { f.records.en.node = 'v25.0.0'; }],
    ['different architecture', f => { f.records.platform.arch = 'arm64'; }],
  ]) {
    await t.test(name, async child => {
      const f = await fixture(child);
      mutate(f);
      for (const key of Object.keys(f.paths)) await writeFile(f.paths[key], JSON.stringify(f.records[key]));
      await assert.rejects(prepareRelease(f.options));
    });
  }
  await t.test('ambiguous old reports', async child => {
    const f = await fixture(child);
    await mkdir(join(f.options.root, '.local', 'gui', 'client-zh-old'));
    await assert.rejects(prepareRelease(f.options), /one fresh/);
  });
  await t.test('missing locale', async child => {
    const f = await fixture(child);
    await rm(join(f.options.root, '.local', 'gui', 'client-en-fixture'), { recursive: true });
    await assert.rejects(prepareRelease(f.options), /one fresh/);
  });
});

test('altered tarballs and different tested payloads are rejected before staging', async t => {
  const f = await fixture(t);
  await writeFile(f.records.en.tarball, 'tampered bytes');
  await assert.rejects(prepareRelease(f.options), /bytes changed/);
  f.records.en.sha256 = hash('tampered bytes');
  await writeFile(f.paths.en, JSON.stringify(f.records.en));
  await assert.rejects(prepareRelease(f.options), /identical tarball/);
});

test('downloaded artifacts must match the publishing tag, commit, package and bytes', async t => {
  const f = await fixture(t);
  await prepareRelease(f.options);
  await assert.rejects(verifyRelease({ ...f.options, manifest, commit: 'b'.repeat(40) }));
  await assert.rejects(verifyRelease({ ...f.options, manifest: { ...manifest, name: 'another-package' } }));
  await assert.rejects(verifyRelease({ ...f.options, manifest, ref: 'refs/tags/v9.9.9' }));
  await writeFile(join(f.options.output, 'dsh-session-bin.tgz'), 'tampered asset');
  await assert.rejects(verifyRelease({ ...f.options, manifest }));
});
