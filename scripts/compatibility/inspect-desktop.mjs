import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
assert(process.versions.electron, 'Inspect the actual official Electron carrier');
const descriptor = JSON.parse(await readFile(join(process.argv[2], 'desktop-runtime.json'), 'utf8'));
console.log(JSON.stringify({ sdk: descriptor.release.version, hostProtocolVersion: descriptor.release.hostProtocolVersion,
  releaseNodeVersion: descriptor.release.nodeVersion, platform: process.platform, arch: process.arch,
  node: process.versions.node, electron: process.versions.electron, uv: process.versions.uv,
  modules: process.versions.modules, sqlite: process.versions.sqlite, zstd: process.versions.zstd }));
