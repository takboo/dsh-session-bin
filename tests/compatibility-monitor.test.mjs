import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { digest, selectTargets, marker, aggregate, compareVersions, previousReports, subprocessStatus } from '../scripts/compatibility/common.mjs';
import { combineTargets, parseDesktopFeed } from '../scripts/compatibility/discover.mjs';
import { targetManifest, validateProposal } from '../scripts/compatibility/proposal.mjs';
import { issueBody } from '../scripts/compatibility/report.mjs';
const baseline = '0.2.1-rc.3';
const target = (v = '0.2.1-rc.4', extra = {}) => ({ version: v, channels: ['npm:next'], npm: { publishedAt: '2026-10-26T15:28:13Z', integrity: 'sha512-test' }, identity: digest(v), ...extra });
const issue = (t, status, attempts = 1, login = 'github-actions[bot]') => ({ number: 15, user: { login }, updated_at: '2026-10-27T00:00:00Z',
  body: `<!-- dsh-compat-v2:${JSON.stringify({ version: t.version, identity: t.identity, status, attempts })} -->` });
const now = Date.parse('2026-10-27T07:00:00Z');
test('release discovery detects npm-first rc.4, merges channels and refuses unofficial tarballs', () => {
  const v = '0.2.1-rc.4';
  const registry = { 'dist-tags': { latest: baseline, next: v }, versions: { [v]: { dist: { integrity: 'sha512-test', tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${v}.tgz` } } }, time: { [v]: '2026-10-26T15:28:13Z' } };
  const one = combineTargets(registry, [], {}, baseline);
  assert.equal(one.length, 1); assert.deepEqual(one[0].channels, ['npm:next']);
  const two = combineTargets(registry, [{ id: 1, tag_name: `dsh-v${v}`, published_at: '2026-10-27T00:00:00Z' }], {}, baseline);
  assert.equal(two.length, 1); assert.deepEqual(two[0].channels, ['github', 'npm:next']); assert.notEqual(two[0].identity, one[0].identity);
  registry.versions[v].dist.tarball = 'https://example.org/evil.tgz';
  assert.throws(() => combineTargets(registry, [], {}, baseline));
});
test('completed versions are deduplicated; later release/feed identities can supplement one Issue', () => {
  const t = target(); assert.deepEqual(selectTargets([t], [issue(t, 'partial')], { baseline, now }), []);
  const changed = { ...t, identity: digest('desktop arrived') };
  const [selected] = selectTargets([changed], [issue(t, 'partial')], { baseline, now });
  assert.equal(selected.issue, 15); assert.equal(selected.attempts, 0);
});
test('infrastructure retries are spaced, bounded, and manual dispatch can repeat failed versions', () => {
  const t = target();
  assert.equal(selectTargets([t], [issue(t, 'retry')], { baseline, now }).length, 1);
  assert.equal(selectTargets([t], [issue(t, 'running')], { baseline, now }).length, 1);
  assert.equal(selectTargets([t], [issue(t, 'retry')], { baseline, now: now - 2 * 3600000 }).length, 0);
  assert.equal(selectTargets([t], [issue(t, 'retry', 3)], { baseline, now }).length, 0);
  assert.equal(selectTargets([t], [issue(t, 'failed')], { baseline, now }).length, 0);
  assert.equal(selectTargets([t], [issue(t, 'failed', 3)], { baseline, now, manual: t.version }).length, 1);
});
test('registry tag rollback cannot create a downgrade and malformed/manual shell values are rejected', () => {
  assert.equal(selectTargets([target(baseline), target('0.2.1-rc.2')], [], { baseline }).length, 0);
  assert.equal(compareVersions('0.2.1', '0.2.1-rc.99'), 1);
  assert.throws(() => selectTargets([], [], { baseline, manual: '0.2.1;echo secret' }));
});
test('only bot or repository owner markers are trusted, not unrelated users or pull requests', () => {
  const t = target(); assert.equal(previousReports([issue(t, 'passed', 1, 'someone')]).size, 0);
  assert.equal(previousReports([{ ...issue(t, 'passed'), pull_request: {} }]).size, 0);
  assert.equal(previousReports([issue(t, 'passed', 1, 'takboo')]).get(t.version).issue, 15);
  assert.equal(marker('<!-- dsh-compat-v2:{"version":"evil"} -->'), undefined);
});
test('missing, interrupted and partial matrix reports never yield a passing conclusion', () => {
  assert.equal(aggregate([], 5), 'retry'); assert.equal(aggregate([{ status: 'passed' }], 5), 'retry');
  assert.equal(aggregate([{ status: 'partial' }], 1), 'partial');
  assert.equal(aggregate([{ status: 'failed' }], 5), 'failed');
  assert.equal(aggregate([{ status: 'running' }], 1), 'retry');
});
test('dependency proposals cannot modify scripts, production admission or extra files', async () => {
  const base = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const policies = await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
  const v = '9.0.0-rc.1', sha = 'a'.repeat(40);
  const files = { 'package.json': JSON.stringify(targetManifest(base, v)), 'pnpm-workspace.yaml': policies.replaceAll(`@${base.engines.dsh}`, `@${v}`),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\nimporters:\n  .: {}\npackages: {}\nsnapshots: {}\n' };
  const proposal = { version: v, sourceCommit: sha, files };
  assert.equal(Object.keys(validateProposal(proposal, base, policies, v, sha)).length, 3);
  const evil = structuredClone(proposal); const m = JSON.parse(evil.files['package.json']); m.scripts.postinstall = 'evil'; evil.files['package.json'] = JSON.stringify(m);
  assert.throws(() => validateProposal(evil, base, policies, v, sha));
  assert.throws(() => validateProposal({ ...proposal, files: { ...files, 'src/host/native-retirement-sdk.ts': 'unsafe' } }, base, policies, v, sha));
  assert.throws(() => targetManifest(base, '0.0.1'));
});
test('Issue reports label candidate evidence and retain run/source identities without claiming production support', () => {
  const t = target(); const body = issueBody(t, [], { status: 'retry', attempts: 1, runUrl: 'https://github.com/takboo/dsh-session-bin/actions/runs/1', sourceCommit: 'a'.repeat(40) });
  assert.equal(marker(body).version, t.version); assert.match(body, /candidate evidence/); assert.match(body, /14 days/); assert.match(body, /six hours/);
});
test('workflow keeps hourly monitoring, fourteen-day retention and isolated write permissions', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/dsh-compatibility.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.on.schedule[0].cron, '17 * * * *');
  assert.deepEqual(workflow.jobs.check.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.report.permissions.issues, 'write');
  assert.equal(workflow.jobs.track.permissions.issues, 'write');
  assert.deepEqual(workflow.jobs.check.needs, ['discover', 'track']);
  assert.match(workflow.jobs.report.if, /event_name != 'pull_request'/);
  const upload = workflow.jobs.check.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with['retention-days'], 14);
  assert.equal(workflow.jobs.check.strategy.matrix.runner.length, 5);
  assert(!JSON.stringify(workflow).includes('npm publish'));
});

test('subprocess classification separates network/sandbox setup from real assertions and integrity failures', () => {
  assert.equal(subprocessStatus({ code: 0 }), 'passed');
  assert.equal(subprocessStatus({ code: 1, log: 'AssertionError: wrong operation result' }), 'failed');
  assert.equal(subprocessStatus({ code: 1, log: 'kill EPERM' }), 'retry');
  assert.equal(subprocessStatus({ code: 1, setup: true, log: 'ECONNRESET' }), 'retry');
  assert.equal(subprocessStatus({ code: 1, setup: true, log: 'ERR_PNPM_TARBALL_INTEGRITY' }), 'failed');
  assert.equal(subprocessStatus({ code: null, signal: 'SIGTERM' }), 'retry');
});

test('lightweight discovery parses only trusted Desktop feed scalars without installing the SDK', () => {
  const feed = 'version: 0.2.1-rc.4\nfiles: []\npath: >-\n  https://download.deepseek.com/dsh-desk/bin/mac-arm64/test.zip\nsha512: >-\n  ' + 'a'.repeat(86) + '==\n';
  assert.equal(parseDesktopFeed(feed).version, '0.2.1-rc.4');
  assert.throws(() => parseDesktopFeed(feed.replace('download.deepseek.com', 'example.org')));
  assert.throws(() => parseDesktopFeed('version: invalid'));
});
