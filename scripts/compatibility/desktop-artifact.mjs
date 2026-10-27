import assert from 'node:assert/strict';
import { version } from './common.mjs';

export function validateDesktopTarget(target) {
  version(target.version);
  const desktop = target.desktop;
  assert(desktop && desktop.version === target.version, 'Matching official Desktop feed identity is required');
  assert(/^[A-Za-z\d+/]+={0,2}$/.test(desktop.sha512) && Buffer.from(desktop.sha512, 'base64').length === 64, 'Expected SHA-512 Desktop integrity');
  const url = new URL(desktop.path);
  assert.equal(url.origin, 'https://download.deepseek.com');
  assert.equal(url.pathname, `/dsh-desk/bin/mac-arm64/deepseek-harness-${target.version}-mac-arm64.zip`);
  assert(!url.search && !url.hash && !url.username && !url.password);
  return desktop;
}
export function validateArchivePaths(paths) {
  assert(paths.length > 0 && paths.length < 100000);
  for (const path of paths) {
    assert(!path.includes('\\') && !path.startsWith('/') && !path.split('/').includes('..'), 'Unsafe Desktop archive path');
    assert(path === 'DeepSeek Harness.app/' || path.startsWith('DeepSeek Harness.app/'), 'Unexpected Desktop archive root');
  }
}
export function validateSignature(details) {
  assert(/^Identifier=com\.deepseek\.dsh$/m.test(details), 'Unknown Desktop bundle identifier');
  assert(/^TeamIdentifier=NAN929V4UM$/m.test(details), 'Unknown Desktop signing team');
}
export function validateDesktopRuntime(runtime, targetVersion) {
  assert.equal(runtime.sdk, version(targetVersion));
  assert.equal(runtime.platform, 'darwin'); assert.equal(runtime.arch, 'arm64');
  assert.equal(runtime.node, '24.21.0'); assert.equal(runtime.electron, '44.7.0'); assert.equal(runtime.uv, '1.52.1');
  assert.equal(runtime.modules, '149'); assert.equal(runtime.hostProtocolVersion, 4);
  assert.equal(runtime.sqlite, '3.53.4'); assert.equal(runtime.zstd, '1.6.0');
  assert.equal(runtime.releaseNodeVersion, runtime.node);
  // Unknown carriers require source review. This verifier cannot expand production runtime lists.
}
