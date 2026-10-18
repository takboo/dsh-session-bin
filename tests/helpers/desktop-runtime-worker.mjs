import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createScratch, transcript } from './fixture.mjs';
import { openNativeDeletionFixture } from './native-deletion-fixture.mjs';
import { nativePlatformVerified } from '../../dist/index.js';

assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.equal(process.versions.electron, '44.7.0');
assert.equal(process.versions.node, '24.21.0');
assert.equal(process.versions.uv, '1.52.1');
assert.equal(process.env.DSH_SESSION_BIN_DESKTOP_VERIFY, undefined, 'Final Desktop evidence requires production composition.');
assert.equal(process.env.DSH_SESSION_BIN_PLATFORM_VERIFY, undefined);
const sdkRoot = process.env.DSH_SESSION_BIN_DESKTOP_SDK;
const descriptor = JSON.parse(await readFile(join(sdkRoot, 'desktop-runtime.json'), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
assert.equal(descriptor.release.version, manifest.engines.dsh);
assert.equal(descriptor.release.nodeVersion, process.versions.node);
assert.equal(descriptor.platform, process.platform);
assert.equal(descriptor.arch, process.arch);
const require = createRequire(join(sdkRoot, 'package.json'));
const source = await readFile(new URL('../../src/host/native-retirement-sdk.ts', import.meta.url), 'utf8');
const expected = Function(`return (${source.match(/export const nativeRetirementSdkSources = (\{[\s\S]*?\}) as const;/)[1]})`)();
for (const name of ['dsh-agent', 'dsh-agent-loop']) expected[name] = {
  version: manifest.engines.dsh,
  files: { 'lib/index.js': source.match(new RegExp(`'${name}': '([a-f0-9]+)'`))[1] },
};
const sources = [];
for (const [name, entry] of Object.entries(expected)) {
  const metadata = require.resolve(`@deepseek-ai/${name}/package.json`);
  assert(metadata.startsWith(sdkRoot), 'Host SDK must resolve into the actual Desktop archive.');
  assert.equal(JSON.parse(await readFile(metadata, 'utf8')).version, entry.version);
  for (const [file, hash] of Object.entries(entry.files)) {
    const sha256 = createHash('sha256').update(await readFile(join(dirname(metadata), file))).digest('hex');
    assert.equal(sha256, hash, `${name}/${file}`);
    sources.push({ name, version: entry.version, file, sha256 });
  }
}
assert(nativePlatformVerified(), 'The installed Desktop carrier must have independent production qualification.');
const root = await createScratch('desktop-production-probe-');
const fixture = await openNativeDeletionFixture(root, { seed: true, productService: true });
try {
  const before = await transcript(fixture, 'quiet');
  const plan = await fixture.module.preparePurge({ sessionId: 'quiet' });
  assert.deepEqual(plan.blockers, [], 'Permanent deletion is not supported by this Host and storage combination.');
  assert.deepEqual(await transcript(fixture, 'quiet'), before);
  console.log(JSON.stringify({ status: 'passed', sdk: descriptor.release.version,
    node: process.versions.node, uv: process.versions.uv, electron: process.versions.electron,
    modules: process.versions.modules, sqlite: process.versions.sqlite, zstd: process.versions.zstd,
    platform: process.platform, arch: process.arch, sources, prepareBlockers: plan.blockers,
    limits: 'Temporary DSH_HOME; this probe prepares without deleting. The full suite separately tests actual erasure and process death.' }));
} finally { await fixture.close(); }
