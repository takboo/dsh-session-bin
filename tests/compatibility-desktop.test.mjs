import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { digest, marker } from '../scripts/compatibility/common.mjs';
import { componentIdentities, componentDue, plannedComponents, selectChecks } from '../scripts/compatibility/planning.mjs';
import { completedComponents, overallStatus, proposalStatusBody, validateReport } from '../scripts/compatibility/report.mjs';
import { validateArchivePaths, validateDesktopRuntime, validateDesktopTarget, validateSignature } from '../scripts/compatibility/desktop-artifact.mjs';

const version = '0.2.1-rc.4', baseline = '0.2.1-rc.3', sha = 'a'.repeat(40);
const now = Date.parse('2026-10-27T08:00:00Z');
const desktop = { version, sha512: Buffer.alloc(64, 1).toString('base64'), path: `https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-${version}-mac-arm64.zip` };
const target = (withDesktop = false) => ({ version, identity: digest(withDesktop), channels: ['npm:next'], npm: { integrity: 'sha512-fixture', publishedAt: '2026-10-26T00:00:00Z' }, ...(withDesktop ? { desktop } : {}) });
function state(t, key, status = 'partial', attempts = 1) {
  return { identity: componentIdentities(t)[key], status, attempts, run: '111', sourceCommit: sha, updatedAt: '2026-10-27T00:00:00Z' };
}
const issue = (t, components) => ({ number: 16, user: { login: 'github-actions[bot]' }, updated_at: '2026-10-27T00:00:00Z',
  body: `<!-- dsh-compat-v2:${JSON.stringify({ version, identity: t.identity, status: 'partial', attempts: 1, run: '111', components })} -->` });

test('Desktop arrival schedules only one Desktop component and preserves completed SDK evidence', () => {
  const npm = target(), arrived = target(true);
  const [plan] = selectChecks([arrived], [issue(npm, { sdk: state(npm, 'sdk') })], { baseline, now });
  assert.equal(plan.runSdk, false); assert.equal(plan.runDesktop, true); assert.equal(plan.issue, 16);
  const complete = { sdk: state(arrived, 'sdk'), desktop: state(arrived, 'desktop') };
  assert.deepEqual(selectChecks([arrived], [issue(arrived, complete)], { baseline, now }), []);
});
test('Desktop infrastructure retries are bounded and independent of SDK failures/completion', () => {
  const t = target(true), components = { sdk: state(t, 'sdk', 'failed'), desktop: state(t, 'desktop', 'retry') };
  const [plan] = selectChecks([t], [issue(t, components)], { baseline, now });
  assert.equal(plan.runSdk, false); assert.equal(plan.runDesktop, true);
  assert.equal(componentDue({ ...components.desktop, attempts: 3 }, t && componentIdentities(t).desktop, { now }), false);
  assert.equal(componentDue(components.desktop, componentIdentities(t).desktop, { now: now - 7 * 3600000 }), false);
  assert.equal(componentDue({ ...components.desktop, status: 'failed' }, componentIdentities(t).desktop, { now }), false);
});
test('new package identity invalidates both components, while Release metadata alone starts no expensive jobs', () => {
  const t = target(true), components = { sdk: state(t, 'sdk'), desktop: state(t, 'desktop') };
  const changed = { ...t, identity: digest('new npm'), npm: { ...t.npm, integrity: 'sha512-changed' } };
  const [plan] = selectChecks([changed], [issue(t, components)], { baseline, now });
  assert(plan.runSdk && plan.runDesktop);
  const metadata = { ...t, identity: digest('release arrived'), release: { id: 2 } };
  const [lightweight] = selectChecks([metadata], [issue(t, components)], { baseline, now });
  assert.equal(lightweight.runSdk, false); assert.equal(lightweight.runDesktop, false); assert.equal(lightweight.metadataOnly, true);
});
test('legacy Issue state migrates once and manual/PR checks revalidate current changes', () => {
  const t = target(true), legacy = issue(t, undefined);
  const [migration] = selectChecks([t], [legacy], { baseline, now }); assert(migration.runSdk && migration.runDesktop);
  const complete = issue(t, { sdk: state(t, 'sdk'), desktop: state(t, 'desktop') });
  const [manual] = selectChecks([t], [complete], { baseline, now, manual: version }); assert(manual.runSdk && manual.runDesktop);
  const [pr] = selectChecks([t], [complete], { baseline, now, pullRequest: true }); assert(pr.runSdk && pr.runDesktop);
  assert.deepEqual(selectChecks([t], [complete], { baseline: version, now }), []);
});
test('interrupted Desktop attempt keeps SDK run/source identity; finishing does not consume a second attempt', () => {
  const t = { ...target(true), runSdk: false, runDesktop: true }; t.identities = componentIdentities(t);
  const sdk = state(t, 'sdk');
  const running = plannedComponents(t, { sdk }, { run: '222', sourceCommit: 'b'.repeat(40), now: new Date(now).toISOString() });
  assert.deepEqual(running.sdk, sdk); assert.equal(running.desktop.status, 'running'); assert.equal(running.desktop.attempts, 1);
  const done = completedComponents(t, [{ kind: 'desktop', status: 'partial', reason: 'candidate complete' }], running,
    { run: '222', sourceCommit: 'b'.repeat(40), now: new Date(now).toISOString() });
  assert.deepEqual(done.sdk, sdk); assert.equal(done.desktop.attempts, 1); assert.equal(done.desktop.run, '222');
  assert.equal(overallStatus(done, true), 'partial');
  assert.equal(overallStatus({ sdk }, true), 'retry');
  assert.equal(overallStatus({ ...done, desktop: { ...done.desktop, status: 'failed' } }, true), 'failed');
});
test('malformed component markers cannot suppress a real check', () => {
  const t = target(true), bad = issue(t, { desktop: { ...state(t, 'desktop'), sourceCommit: 'untrusted' } });
  assert.equal(marker(bad.body), undefined);
  assert(selectChecks([t], [bad], { baseline, now })[0].runDesktop);
});
test('official ZIP URL, SHA-512, archive containment, publisher and runtime are fail-closed', () => {
  const t = target(true); assert.equal(validateDesktopTarget(t).version, version);
  for (const path of [desktop.path.replace('download.deepseek.com', 'example.org'), desktop.path.replace(version, baseline), desktop.path + '?redirect=1']) {
    assert.throws(() => validateDesktopTarget({ ...t, desktop: { ...desktop, path } }));
  }
  assert.throws(() => validateDesktopTarget({ ...t, desktop: { ...desktop, sha512: 'abcd' } }));
  validateArchivePaths(['DeepSeek Harness.app/', 'DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness']);
  for (const path of ['../escape', '/tmp/escape', 'DeepSeek Harness.app/../../escape', 'DeepSeek Harness.app/..\\escape', 'Other.app/file']) assert.throws(() => validateArchivePaths([path]));
  validateSignature('Identifier=com.deepseek.dsh\nTeamIdentifier=NAN929V4UM\n');
  assert.throws(() => validateSignature('Identifier=com.deepseek.dsh\nTeamIdentifier=UNKNOWN\n'));
  const runtime = { sdk: version, platform: 'darwin', arch: 'arm64', node: '24.21.0', electron: '44.7.0', uv: '1.52.1', modules: '149', sqlite: '3.53.4', zstd: '1.6.0', hostProtocolVersion: 4, releaseNodeVersion: '24.21.0' };
  validateDesktopRuntime(runtime, version);
  for (const changed of [{ electron: '45.0.0' }, { arch: 'x64' }, { sdk: baseline }, { node: '24.18.1' }, { sqlite: '3.54.0' }, { zstd: '1.7.0' }]) assert.throws(() => validateDesktopRuntime({ ...runtime, ...changed }, version));
});
test('desktop report rejects production claims, mismatched artifacts and omitted ASAR/recovery/GUI stages', () => {
  const t = target(true);
  const stages = ['signature-verify', 'signature-identity', 'runtime-inspect', 'normal-asar-refusal', 'normal-electron-loader', 'normal-electron-gui',
    'candidate-asar-suite', 'candidate-asar-upgrade', 'candidate-asar-loader', 'candidate-electron-gui'].map(name => ({ name, status: 'passed' }));
  const r = { kind: 'desktop', version, sourceCommit: sha, target: t, productionAdmissionChanged: false, productionSourcesStable: true,
    productionDeletionQualified: false, platform: 'darwin', arch: 'arm64', status: 'partial', candidateChecksPassed: true,
    artifact: { ...desktop, sha256: 'f'.repeat(64) }, stages,
    runtime: { sdk: version, platform: 'darwin', arch: 'arm64', node: '24.21.0', electron: '44.7.0', uv: '1.52.1', modules: '149', sqlite: '3.53.4', zstd: '1.6.0', hostProtocolVersion: 4, releaseNodeVersion: '24.21.0' } };
  validateReport(r, t, sha, 'desktop');
  for (const changed of [{ productionDeletionQualified: true }, { candidateChecksPassed: false }, { stages: stages.slice(1) },
    { artifact: { ...r.artifact, sha512: 'bad' } }, { target: { ...t, identity: digest('other') } }]) assert.throws(() => validateReport({ ...r, ...changed }, t, sha, 'desktop'));
  const summary = proposalStatusBody(t, { desktop: state(t, 'desktop') }, 'https://github.com/takboo/dsh-session-bin/issues/16');
  assert.match(summary, /Keep this PR draft/); assert.match(summary, /No automatic merge/); assert.match(summary, /issues\/16/);
});
test('one hourly workflow separates SDK and Desktop jobs with fourteen-day evidence and read-only execution', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/dsh-compatibility.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.on.schedule.length, 1); assert.equal(workflow.on.schedule[0].cron, '17 * * * *');
  assert.equal(workflow.jobs.desktop['runs-on'], 'macos-15');
  assert.deepEqual(workflow.jobs.desktop.permissions, { contents: 'read' });
  assert.match(workflow.jobs.desktop.if, /desktop_count/); assert.match(workflow.jobs.check.if, /sdk_count/);
  assert(workflow.jobs.report.needs.includes('desktop'));
  assert.equal(workflow.jobs.desktop.steps.find(s => s.uses?.startsWith('actions/upload-artifact@')).with['retention-days'], 14);
  assert.match(workflow.jobs.report.if, /event_name != 'pull_request'/);
});
