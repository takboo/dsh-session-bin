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
  const lock = parse(proposal.files['pnpm-lock.yaml']);
  assert(lock.lockfileVersion && lock.importers?.['.'] && lock.packages && lock.snapshots);
  validateAgePolicy(parse(policies.replaceAll(`@${baseline.engines.dsh}`, `@${target}`)),
    parse(proposal.files['pnpm-workspace.yaml']), lock);
  for (const entry of Object.values(lock.packages)) {
    if (entry.resolution?.tarball) assert(new URL(entry.resolution.tarball).origin === 'https://registry.npmjs.org');
  }
  return proposal.files;
}

function exactExceptions(entries = []) {
  assert(Array.isArray(entries));
  return new Set(entries.flatMap(entry => {
    assert.equal(typeof entry, 'string');
    const match = /^((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(entry);
    assert(match, 'Release-age exceptions must name exact packages.');
    return match[2].split(' || ').map(value => `${match[1]}@${version(value)}`);
  }));
}

/** pnpm may normalize quoting and add exact transitive release-age exceptions.
 * Only the frozen official SDK dependency graph can justify new exceptions;
 * all other policy fields and every reviewed exception remain unchanged. */
function validateAgePolicy(expected, proposed, lock) {
  const { minimumReleaseAgeExclude: before, ...basePolicy } = expected;
  const { minimumReleaseAgeExclude: after, ...nextPolicy } = proposed;
  assert.deepEqual(nextPolicy, basePolicy, 'A dependency proposal cannot change other package-manager policy.');
  const reviewed = exactExceptions(before), offered = exactExceptions(after);
  for (const entry of reviewed) assert(offered.has(entry), `Missing reviewed release-age exception: ${entry}`);
  const reachable = new Set(), visited = new Set(), pending = [];
  const importer = lock.importers['.'];
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, entry] of Object.entries(importer[group] ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh')) pending.push([name, entry.version]);
    }
  }
  while (pending.length) {
    const [name, resolved] = pending.pop();
    assert.equal(typeof resolved, 'string');
    const snapshotKey = `${name}@${resolved}`;
    if (visited.has(snapshotKey)) continue;
    visited.add(snapshotKey);
    const plainKey = `${name}@${resolved.split('(')[0]}`;
    if (name.startsWith('@deepseek-ai/') && Object.hasOwn(lock.packages, plainKey)) reachable.add(plainKey);
    const snapshot = lock.snapshots[snapshotKey];
    for (const group of ['dependencies', 'optionalDependencies']) {
      for (const child of Object.entries(snapshot?.[group] ?? {})) pending.push(child);
    }
  }
  for (const entry of offered) {
    assert(reviewed.has(entry) || reachable.has(entry), `Unreviewed release-age exception is outside the frozen SDK graph: ${entry}`);
  }
}
