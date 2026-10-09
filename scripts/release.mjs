import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const numeric = '(?:0|[1-9][0-9]*)';
const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export function releaseTag(manifest, ref) {
  assert(semver.test(manifest.version), 'Package version must be valid SemVer.');
  const tag = `v${manifest.version}`;
  assert.equal(ref, `refs/tags/${tag}`, 'Release tag must equal v + package.json version.');
  return { tag, prerelease: manifest.version.split('+')[0].includes('-') };
}

async function singleReport(root, directory, prefix) {
  const parent = join(root, '.local', directory);
  const entries = (await readdir(parent, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix));
  assert.equal(entries.length, 1, `Expected one fresh ${prefix} report; use a clean CI workspace.`);
  const report = await json(join(parent, entries[0].name, 'verification.json'));
  assert.equal(report.status, 'passed', `${prefix} verification must pass.`);
  assert.equal(report.platform, 'linux');
  assert.equal(report.arch, 'x64');
  return report;
}

export async function prepareRelease({ root, output, commit, ref, repository }) {
  const manifest = await json(join(root, 'package.json'));
  assert(semver.test(manifest.version), 'Package version must be valid SemVer.');
  assert(/^[a-f0-9]{40}$/.test(commit), 'Release metadata requires a full Git commit SHA.');
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), 'A GitHub owner/repository is required.');
  const tagged = ref.startsWith('refs/tags/v') ? releaseTag(manifest, ref) : null;
  const platform = await singleReport(root, 'platform', 'linux-x64-');
  assert.equal(platform.packageVersion, manifest.version);
  assert.equal(platform.sourcesStable, true);
  assert.equal(platform.exitCode, 0);
  assert.equal(platform.sdk, manifest.engines.dsh);
  assert.equal(platform.node, manifest.engines.node);

  const loader = await singleReport(root, 'lifecycle', 'package-');
  assert.equal(loader.productionDeletionQualified, true, 'Release requires real production deletion verification.');
  const reports = [loader];
  for (const [prefix, locale] of [['client-zh-', 'zh-CN'], ['client-en-', 'en-US']]) {
    const report = await singleReport(root, 'gui', prefix);
    assert.equal(report.locale, locale);
    assert.equal(report.sdk, manifest.engines.dsh);
    assert.equal(report.deletionQualification, 'supported');
    reports.push(report);
  }
  for (const report of reports) {
    assert.equal(report.node.replace(/^v/, ''), manifest.engines.node);
    const hash = digest(await readFile(report.tarball));
    assert.equal(hash, report.sha256, 'Tested tarball bytes changed after verification.');
    assert.equal(hash, loader.sha256, 'Loader and both GUI locales must verify identical tarball bytes.');
  }

  // Copy the tested payload; never rebuild between verification and publication.
  await mkdir(output, { recursive: true });
  await copyFile(loader.tarball, join(output, 'dsh-session-bin.tgz'));
  const metadata = {
    package: manifest.name, version: manifest.version, commit, tag: tagged?.tag ?? null,
    sha256: loader.sha256, sdk: platform.sdk, node: platform.node, libuv: platform.libuv,
    sourceSha256: platform.sourceSha256, filesystem: platform.filesystem,
    verifiedPayload: ['Cordis Loader', 'zh-CN CLI/GUI', 'en-US CLI/GUI'],
  };
  await writeFile(join(output, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
  await writeFile(join(output, 'SHA256SUMS'),
    `${loader.sha256}  dsh-session-bin.tgz\n${digest(await readFile(join(output, 'release.json')))}  release.json\n`);
  const snapshot = `https://github.com/${repository}/blob/${commit}`;
  await writeFile(join(output, 'RELEASE_NOTES.md'),
    `Precompiled ${manifest.name}@${manifest.version}, from commit \`${commit}\`.\n\n`
    + `The attached tarball was verified by the real Cordis Loader and both Chinese and English CLI/GUI fixtures. Publication waits for all five native platform jobs.\n\n`
    + `Runtime: DSH ${platform.sdk}, Node ${platform.node}, libuv ${platform.libuv}; single Host and verified JSONL combinations only. See the [supported environments and usage](${snapshot}/README.md#兼容性). Shared attachments and independent forks are retained; secure erasure and multi-Host coordination are outside the support scope.\n\n`
    + `Download dsh-session-bin.tgz, SHA256SUMS and release.json together, then run \`sha256sum --check SHA256SUMS\`. npm publication must reuse this exact tarball.\n`);
  return metadata;
}

export async function verifyRelease({ output, manifest, commit, ref }) {
  const tagged = releaseTag(manifest, ref);
  const metadata = await json(join(output, 'release.json'));
  assert.equal(metadata.package, manifest.name);
  assert.equal(metadata.version, manifest.version);
  assert.equal(metadata.commit, commit);
  assert.equal(metadata.tag, tagged.tag);
  assert.equal(digest(await readFile(join(output, 'dsh-session-bin.tgz'))), metadata.sha256);
  return tagged;
}

if (import.meta.main) {
  const root = process.cwd();
  const manifest = await json(join(root, 'package.json'));
  const ref = process.env.GITHUB_REF ?? '';
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const output = resolve(root, '.local', 'release');
  switch (process.argv[2]) {
    case 'check-tag':
      releaseTag(manifest, ref);
      execFileSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], { cwd: root });
      assert.equal(commit, process.env.GITHUB_SHA, 'Checkout must match the triggering commit.');
      break;
    case 'prepare':
      await prepareRelease({ root, output, commit, ref, repository: process.env.GITHUB_REPOSITORY });
      break;
    case 'check-artifact': {
      const result = await verifyRelease({ output, manifest, commit, ref });
      await appendFile(process.env.GITHUB_OUTPUT, `prerelease=${result.prerelease}\n`);
      break;
    }
    default: throw new Error('Use check-tag, prepare, or check-artifact.');
  }
}
