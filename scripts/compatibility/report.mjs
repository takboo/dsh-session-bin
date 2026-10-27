// Adapted from dsh-usage-state's report.mjs; Copyright (c) 2026 takboo (MIT).
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { aggregate, assertRepository, marker, pages, previousReports, request, safe, version } from './common.mjs';
export function issueBody(target, reports, { status, attempts, runUrl, sourceCommit, proposalUrl = '', details = '' }) {
  const state = { version: version(target.version), identity: target.identity, status, attempts, run: /\/runs\/(\d+)$/.exec(runUrl)?.[1] };
  assert(/^[a-f\d]{64}$/.test(state.identity));
  return [
    `<!-- dsh-compat-v2:${JSON.stringify(state)} -->`,
    `Target: **DSH ${safe(target.version)}**; channels: ${target.channels.map(safe).join(', ')}`,
    `npm published: ${safe(target.npm.publishedAt)}; integrity: \`${safe(target.npm.integrity)}\``,
    `Upstream commit: ${safe(target.commit ?? target.npm.commit ?? 'not available; npm publication only')}`,
    `Plugin source commit: \`${safe(sourceCommit)}\`; [Actions evidence](${runUrl})`,
    `Result: **${status}** (attempt ${attempts})`, '',
    ...reports.map(r => `- ${safe(r.platform)}/${safe(r.arch)}: **${safe(r.status)}** — ${safe(r.reason)}`), '',
    proposalUrl ? `Dependency proposal: ${proposalUrl}` : '', safe(details), '',
    'This is candidate evidence, not a production compatibility declaration. Production deletion admission is unchanged. No automatic merge, tag or release.',
    'Official Desktop/Electron/ASAR qualification and source review are separate requirements. See each report for scope and omissions.',
    'Artifacts expire after 14 days. This Issue preserves the summary and source/run identities.',
    status === 'retry' ? 'Infrastructure/incomplete run: retry after six hours, at most three automatic attempts per target identity. Manual exact-version dispatch remains available.'
      : 'No automatic rerun for test failures or completed candidate checks; dispatch the exact version to repeat.',
  ].filter(line => line !== '').join('\n');
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
  const token = process.env.GH_TOKEN;
  assert(token, 'A reporting token is required');
  const repo = assertRepository(process.env.GITHUB_REPOSITORY);
  const target = JSON.parse(process.env.DSH_TARGET_JSON); version(target.version);
  const sourceCommit = process.env.GITHUB_SHA; assert(/^[a-f\d]{40}$/.test(sourceCommit));
  const run = process.env.GITHUB_RUN_ID; assert(/^\d+$/.test(run));
  const runUrl = `https://github.com/${repo}/actions/runs/${run}`;
  if (process.argv.includes('--start')) {
    const issues = await pages(`/repos/${repo}/issues?state=all`, token);
    const old = previousReports(issues).get(target.version);
    const attempts = (old?.identity === target.identity ? old.attempts : 0) + 1;
    const body = issueBody(target, [], { status: 'running', attempts, runUrl, sourceCommit,
      details: 'Checks are running. An interrupted workflow remains incomplete and is eligible for the bounded six-hour retry policy.' });
    const issue = await request(`https://api.github.com/repos/${repo}/issues${old ? `/${old.issue}` : ''}`, { token, method: old ? 'PATCH' : 'POST',
      body: old ? { body } : { title: `DSH compatibility check: ${target.version}`, body } });
    console.log(JSON.stringify({ issue: issue.html_url, status: 'running', attempts }));
    return;
  }
  const reports = []; let proposal;
  const directory = process.argv[2];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!/^dsh-check-[\w.-]+$/.test(name)) continue;
    try {
      const r = JSON.parse(await readFile(join(directory, name, 'report.json'), 'utf8'));
      assert.equal(r.version, target.version); assert.equal(r.sourceCommit, sourceCommit);
      assert.equal(r.productionAdmissionChanged, false); assert.equal(r.productionSourcesStable, true);
      assert(['passed', 'partial', 'failed', 'retry'].includes(r.status));
      assert(['darwin/arm64','darwin/x64','win32/x64','linux/arm64','linux/x64'].includes(`${r.platform}/${r.arch}`));
      assert(!reports.some(old => old.platform === r.platform && old.arch === r.arch));
      reports.push(r);
      if (r.platform === 'linux' && r.arch === 'x64') proposal = JSON.parse(await readFile(join(directory, name, 'proposal.json'), 'utf8'));
    } catch (error) { console.error(`Incomplete report ${name}: ${safe(error.message)}`); }
  }
  const status = aggregate(reports, 5);
  const issues = await pages(`/repos/${repo}/issues?state=all`, token);
  const old = previousReports(issues).get(target.version);
  const attempts = old?.identity === target.identity && old.run === run ? old.attempts : (old?.identity === target.identity ? old.attempts : 0) + 1;
  let body = issueBody(target, reports, { status, attempts, runUrl, sourceCommit });
  const issue = await request(`https://api.github.com/repos/${repo}/issues${old ? `/${old.issue}` : ''}`, { token, method: old ? 'PATCH' : 'POST',
    body: old ? { body } : { title: `DSH compatibility check: ${target.version}`, body } });
  let result = {};
  if (proposal) {
    try { result = await createProposal(target, proposal, repo, token, sourceCommit, issue.html_url); }
    catch (error) { result.detail = `Draft PR not created: ${safe(error.message)}. Dependency proposal remains in the artifact.`; }
    body = issueBody(target, reports, { status, attempts, runUrl, sourceCommit, proposalUrl: result.url, details: result.detail });
    await request(`https://api.github.com/repos/${repo}/issues/${issue.number}`, { token, method: 'PATCH', body: { body } });
  }
  console.log(JSON.stringify({ issue: issue.html_url, status, proposal: result.url, detail: result.detail }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
