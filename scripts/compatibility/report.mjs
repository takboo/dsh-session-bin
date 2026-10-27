// Adapted from dsh-usage-state's report.mjs; Copyright (c) 2026 takboo (MIT).
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { aggregate, assertRepository, marker, pages, previousReports, request, safe, version } from './common.mjs';
import { componentIdentities, plannedComponents, validComponents } from './planning.mjs';
import { validateDesktopRuntime, validateDesktopTarget } from './desktop-artifact.mjs';
export function issueBody(target, reports, { status, attempts, runUrl, sourceCommit, proposalUrl = '', details = '', components }) {
  const state = { version: version(target.version), identity: target.identity, status, attempts, run: /\/runs\/(\d+)$/.exec(runUrl)?.[1] };
  if (components) state.components = validComponents(components);
  assert(/^[a-f\d]{64}$/.test(state.identity));
  return [
    `<!-- dsh-compat-v2:${JSON.stringify(state)} -->`,
    `Target: **DSH ${safe(target.version)}**; channels: ${target.channels.map(safe).join(', ')}`,
    `npm published: ${safe(target.npm.publishedAt)}; integrity: \`${safe(target.npm.integrity)}\``,
    `Upstream commit: ${safe(target.commit ?? target.npm.commit ?? 'not available; npm publication only')}`,
    `Plugin source commit: \`${safe(sourceCommit)}\`; [Actions evidence](${runUrl})`,
    `Result: **${status}** (attempt ${attempts})`, '',
    ...reports.map(r => `- ${r.kind === 'desktop' ? 'Desktop ' : 'SDK '}${safe(r.platform)}/${safe(r.arch)}: **${safe(r.status)}** — ${safe(r.reason)}`), '',
    ...componentLines(components),
    proposalUrl ? `Dependency proposal: ${proposalUrl}` : '', safe(details), '',
    'This is candidate evidence, not a production compatibility declaration. Production deletion admission is unchanged. No automatic merge, tag or release.',
    'Official Desktop checks use an isolated signed ZIP/Electron/ASAR candidate. Source review and production qualification remain separate requirements. See each report for scope and omissions.',
    'Artifacts expire after 14 days. This Issue preserves the summary and source/run identities.',
    status === 'retry' ? 'Infrastructure/incomplete run: retry after six hours, at most three automatic attempts per target identity. Manual exact-version dispatch remains available.'
      : 'No automatic rerun for test failures or completed candidate checks; dispatch the exact version to repeat.',
  ].filter(line => line !== '').join('\n');
}
function componentLines(components = {}) {
  return ['sdk', 'desktop'].map(key => {
    const c = components[key];
    return c ? `${key}: **${safe(c.status)}**, attempt ${c.attempts}; [evidence](https://github.com/takboo/dsh-session-bin/actions/runs/${c.run}), source \`${c.sourceCommit}\`${c.reason ? '; ' + safe(c.reason) : ''}`
      : `${key}: waiting for matching official publication / complete component evidence`;
  });
}
export function validateReport(r, target, sourceCommit, kind) {
  assert.equal(r.version, target.version); assert.equal(r.sourceCommit, sourceCommit);
  assert.equal(r.target?.identity, target.identity);
  assert.equal(r.productionAdmissionChanged, false); assert.equal(r.productionSourcesStable, true);
  assert(['passed', 'partial', 'failed', 'retry'].includes(r.status));
  if (kind === 'desktop') {
    assert.equal(r.kind, 'desktop'); assert.equal(r.platform, 'darwin'); assert.equal(r.arch, 'arm64');
    assert.equal(r.productionDeletionQualified, false);
    if (['passed', 'partial'].includes(r.status)) {
      const desktop = validateDesktopTarget(target);
      assert.equal(r.artifact?.sha512, desktop.sha512); assert.equal(r.artifact?.path, desktop.path);
      assert(/^[a-f\d]{64}$/.test(r.artifact.sha256));
      assert.equal(r.candidateChecksPassed, true); validateDesktopRuntime(r.runtime, target.version);
      for (const name of ['signature-verify', 'signature-identity', 'runtime-inspect', 'normal-asar-refusal', 'normal-electron-loader', 'normal-electron-gui',
        'candidate-asar-suite', 'candidate-asar-upgrade', 'candidate-asar-loader', 'candidate-electron-gui']) assert(r.stages.some(s => s.name === name && s.status === 'passed'), `Missing Desktop stage ${name}`);
    }
  } else {
    assert(!r.kind); assert(['darwin/arm64','darwin/x64','win32/x64','linux/arm64','linux/x64'].includes(`${r.platform}/${r.arch}`));
    if (['passed', 'partial'].includes(r.status)) for (const name of ['normal-loader-refusal', 'normal-gui-refusal', 'candidate-platform', 'upgrade-verify', 'candidate-gui']) {
      assert(r.stages.some(s => s.name === name && s.status === 'passed'), `Missing SDK stage ${name}`);
    }
  }
  return r;
}
export function completedComponents(target, reports, previous, { run, sourceCommit, now = new Date().toISOString() }) {
  const identities = componentIdentities(target);
  const components = {};
  for (const key of ['sdk', 'desktop']) {
    const old = previous?.[key];
    if (!target[key === 'sdk' ? 'runSdk' : 'runDesktop']) {
      if (old?.identity === identities[key]) components[key] = old;
      continue;
    }
    const rows = reports.filter(r => key === 'desktop' ? r.kind === 'desktop' : !r.kind);
    const status = aggregate(rows, key === 'desktop' ? 1 : 5);
    components[key] = { identity: identities[key], status,
      attempts: old?.identity === identities[key] ? old.attempts + (old.run === run ? 0 : 1) : 1,
      run, sourceCommit, updatedAt: now,
      reason: key === 'desktop' && rows[0]?.reason ? safe(rows[0].reason) : `${rows.length}/${key === 'desktop' ? 1 : 5} component reports received`,
      ...(key === 'desktop' && rows[0]?.artifact ? { artifactSha256: rows[0].artifact.sha256 } : {}) };
  }
  return validComponents(components);
}
export function overallStatus(components, hasDesktop) {
  const states = [components.sdk, ...(hasDesktop ? [components.desktop] : [])];
  if (states.some(c => c?.status === 'failed')) return 'failed';
  if (states.some(c => !c || ['running', 'retry'].includes(c.status))) return 'retry';
  // Even all completed candidate checks await source review and production composition evidence.
  return 'partial';
}
export function proposalStatusBody(target, components, issueUrl) {
  return [`<!-- dsh-compat-status:${version(target.version)} -->`, `Automated compatibility evidence for DSH **${target.version}**: ${issueUrl}`,
    ...componentLines(components),
    'Keep this PR draft. Candidate success never changes production admission. Source review and passing full CI on the final production composition are required before a maintainer may mark it ready.',
    'No automatic merge, tag or publication. Existing proposal files and maintainer edits are preserved.'].join('\n\n');
}
async function updateProposalStatus(target, pull, components, issueUrl, repo, token) {
  if (pull.state !== 'open') return;
  if (!pull.draft) {
    const converted = await request('https://api.github.com/graphql', { token, method: 'POST', body: {
      query: 'mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}', variables: { id: pull.node_id } } });
    assert(!converted.errors?.length && converted.data?.convertPullRequestToDraft?.pullRequest?.isDraft, 'Could not preserve draft state');
  }
  const body = proposalStatusBody(target, components, issueUrl);
  const prefix = `<!-- dsh-compat-status:${target.version} -->`;
  const comments = await pages(`/repos/${repo}/issues/${pull.number}/comments`, token);
  const existing = comments.find(c => ['github-actions[bot]', 'takboo'].includes(c.user?.login) && c.body?.startsWith(prefix));
  if (existing?.body === body) return;
  await request(`https://api.github.com/repos/${repo}/${existing ? `issues/comments/${existing.id}` : `issues/${pull.number}/comments`}`,
    { token, method: existing ? 'PATCH' : 'POST', body: { body } });
}
async function createProposal(target, proposal, repo, token, sourceCommit, issueUrl) {
  const baseline = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const policies = await readFile(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8');
  const { validateProposal } = await import('./proposal.mjs');
  const files = validateProposal(proposal, baseline, policies, target.version, sourceCommit);
  const branch = `codex/dsh-compat-${target.version}`;
  const pulls = await pages(`/repos/${repo}/pulls?state=all&head=takboo:${branch}`, token);
  if (pulls.length) return { url: pulls[0].html_url, detail: 'Existing proposal preserved; automatic runs do not overwrite maintainer edits.' };
  const blobs = [];
  for (const [path, content] of Object.entries(files)) {
    const blob = await request(`https://api.github.com/repos/${repo}/git/blobs`, { token, method: 'POST', body: { content, encoding: 'utf-8' } });
    blobs.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const base = await request(`https://api.github.com/repos/${repo}/git/commits/${sourceCommit}`, { token });
  const tree = await request(`https://api.github.com/repos/${repo}/git/trees`, { token, method: 'POST', body: { base_tree: base.tree.sha, tree: blobs } });
  const commit = await request(`https://api.github.com/repos/${repo}/git/commits`, { token, method: 'POST', body: {
    message: `chore: prepare DSH ${target.version} candidate dependencies`, tree: tree.sha, parents: [sourceCommit] } });
  try {
    await request(`https://api.github.com/repos/${repo}/git/refs`, { token, method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  } catch (error) { return { detail: `Proposal branch could not be created; existing branches are never overwritten: ${safe(error.message)}` }; }
  const pull = await request(`https://api.github.com/repos/${repo}/pulls`, { token, method: 'POST', body: { title: `chore: prepare DSH ${target.version} compatibility`,
    head: branch, base: 'main', draft: true,
    body: `Prepare exact DSH ${target.version} dependencies for review. ${issueUrl}\n\nThis proposal changes only package.json, pnpm-lock.yaml and exact release-age exceptions. Production deletion admission, supported runtime/platform lists and release version remain unchanged. Candidate reports are linked in the Issue and do not qualify production deletion.\n\nDo not merge until source review and the required independent production qualification are complete. No automatic merge or publication.` } });
  return { url: pull.html_url };
}
async function main() {
  const token = process.env.GH_TOKEN; assert(token, 'A reporting token is required');
  const repo = assertRepository(process.env.GITHUB_REPOSITORY);
  const target = JSON.parse(process.env.DSH_TARGET_JSON); version(target.version);
  target.identities = componentIdentities(target);
  // Older manual invocations remain a complete SDK check, never an implicit Desktop pass.
  target.runSdk ??= true; target.runDesktop ??= false;
  const sourceCommit = process.env.GITHUB_SHA; assert(/^[a-f\d]{40}$/.test(sourceCommit));
  const run = process.env.GITHUB_RUN_ID; assert(/^\d+$/.test(run));
  const runUrl = `https://github.com/${repo}/actions/runs/${run}`;
  const issues = await pages(`/repos/${repo}/issues?state=all`, token);
  const old = previousReports(issues).get(target.version);
  const attempts = old?.identity === target.identity && old.run === run ? old.attempts : (old?.identity === target.identity ? old.attempts : 0) + 1;
  const upsert = body => request(`https://api.github.com/repos/${repo}/issues${old ? `/${old.issue}` : ''}`, { token, method: old ? 'PATCH' : 'POST',
    body: old ? { body } : { title: `DSH compatibility check: ${target.version}`, body } });
  if (process.argv.includes('--start')) {
    const components = plannedComponents(target, old?.components, { run, sourceCommit });
    const issue = await upsert(issueBody(target, [], { status: 'running', attempts, runUrl, sourceCommit, components,
      details: 'Only due components are running. Completed component evidence retains its original run/source identity. An interrupted component is eligible for bounded six-hour retries.' }));
    console.log(JSON.stringify({ issue: issue.html_url, status: 'running', attempts })); return;
  }
  const reports = []; let proposal;
  const directory = process.argv[2];
  for (const name of await readdir(directory).catch(() => [])) {
    const kind = name.startsWith('dsh-desktop-') ? 'desktop' : name.startsWith('dsh-check-') ? 'sdk' : null;
    if (!kind) continue;
    try {
      const r = validateReport(JSON.parse(await readFile(join(directory, name, 'report.json'), 'utf8')), target, sourceCommit, kind);
      assert(!reports.some(old => Boolean(old.kind) === Boolean(r.kind) && old.platform === r.platform && old.arch === r.arch));
      reports.push(r);
      if (!r.kind && r.platform === 'linux' && r.arch === 'x64') proposal = JSON.parse(await readFile(join(directory, name, 'proposal.json'), 'utf8'));
    } catch (error) { console.error(`Incomplete report ${name}: ${safe(error.message)}`); }
  }
  const components = completedComponents(target, reports, old?.components, { run, sourceCommit });
  const status = overallStatus(components, Boolean(target.desktop));
  const issue = await upsert(issueBody(target, reports, { status, attempts, runUrl, sourceCommit, components }));
  let result = {};
  if (proposal) {
    try { result = await createProposal(target, proposal, repo, token, sourceCommit, issue.html_url); }
    catch (error) { result.detail = `Draft PR not created: ${safe(error.message)}. Dependency proposal remains in the artifact.`; }
  }
  const pulls = await pages(`/repos/${repo}/pulls?state=all&head=takboo:codex/dsh-compat-${target.version}`, token);
  if (pulls.length) {
    result.url ??= pulls[0].html_url;
    await updateProposalStatus(target, pulls[0], components, issue.html_url, repo, token);
  }
  await upsert(issueBody(target, reports, { status, attempts, runUrl, sourceCommit, components, proposalUrl: result.url, details: result.detail }));
  console.log(JSON.stringify({ issue: issue.html_url, status, proposal: result.url, components }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
