import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { compareVersions, version } from './common.mjs';
export function targetManifest(baseline, target) {
  version(target); assert(compareVersions(target, baseline.engines.dsh) > 0, 'No automatic downgrade');
  const manifest = structuredClone(baseline); manifest.engines.dsh = target;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) for (const name of Object.keys(manifest[section] ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh')) manifest[section][name] = target;
  }
  return manifest;
}
export function validateProposal(proposal, baseline, policies, target, sourceCommit) {
  assert.equal(proposal.version, version(target)); assert.equal(proposal.sourceCommit, sourceCommit);
  assert.deepEqual(Object.keys(proposal.files).sort(), ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);
  for (const content of Object.values(proposal.files)) assert(typeof content === 'string' && Buffer.byteLength(content) < 3 * 1024 * 1024);
  assert.deepEqual(JSON.parse(proposal.files['package.json']), targetManifest(baseline, target));
  assert.equal(proposal.files['pnpm-workspace.yaml'], policies.replaceAll(`@${baseline.engines.dsh}`, `@${target}`));
  const lock = parse(proposal.files['pnpm-lock.yaml']);
  assert(lock.lockfileVersion && lock.importers?.['.'] && lock.packages && lock.snapshots);
  for (const entry of Object.values(lock.packages)) {
    if (entry.resolution?.tarball) assert(new URL(entry.resolution.tarball).origin === 'https://registry.npmjs.org');
  }
  return proposal.files;
}
