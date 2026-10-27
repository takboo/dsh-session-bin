// Discovery/report lifecycle adapted from takboo/dsh-usage-state (MIT).
// Copyright (c) 2026 takboo. See ./LICENSE.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([A-Za-z\d-]+(?:\.[A-Za-z\d-]+)*))?$/;
export function version(value) {
  assert(typeof value === 'string' && value.length <= 100 && versionPattern.test(value), 'Expected exact X.Y.Z or X.Y.Z-prerelease version');
  const m = versionPattern.exec(value);
  assert(m.slice(1, 4).every(v => Number.isSafeInteger(Number(v))), 'Version components exceed SemVer bounds');
  assert(!m[4]?.split('.').some(v => /^\d+$/.test(v) && v.length > 1 && v.startsWith('0')), 'Numeric prerelease identifiers cannot have leading zeros');
  return value;
}
export function compareVersions(a, b) {
  const x = versionPattern.exec(version(a)), y = versionPattern.exec(version(b));
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]) ? 1 : -1;
  if (x[4] === y[4]) return 0;
  if (!x[4] || !y[4]) return !x[4] ? 1 : -1;
  const left = x[4].split('.'), right = y[4].split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    if (left[i] === undefined || right[i] === undefined) return left[i] === undefined ? -1 : 1;
    const xn = /^\d+$/.test(left[i]), yn = /^\d+$/.test(right[i]);
    if (xn && yn) return BigInt(left[i]) > BigInt(right[i]) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const safe = value => String(value ?? '').replace(/[\r\n`<>]/g, ' ').slice(0, 1500);
export function marker(body) {
  const raw = /<!-- dsh-compat-v2:(\{[^\n]+\}) -->/.exec(body ?? '')?.[1];
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    version(data.version);
    assert(['running', 'passed', 'partial', 'failed', 'retry'].includes(data.status));
    assert(Number.isSafeInteger(data.attempts) && data.attempts >= 0 && data.attempts <= 100);
    assert(/^[a-f\d]{64}$/.test(data.identity));
    return data;
  } catch { return; }
}
export function previousReports(issues) {
  const seen = new Map();
  for (const issue of issues) {
    if (issue.pull_request || !['github-actions[bot]', 'takboo'].includes(issue.user?.login)) continue;
    const data = marker(issue.body);
    if (data && (!seen.has(data.version) || Date.parse(issue.updated_at) > seen.get(data.version).updated)) {
      seen.set(data.version, { ...data, issue: issue.number, updated: Date.parse(issue.updated_at) });
    }
  }
  return seen;
}
export function selectTargets(targets, issues, { baseline, manual = '', now = Date.now() } = {}) {
  if (manual) version(manual);
  const seen = previousReports(issues);
  return targets.filter(target => {
    version(target.version);
    if (manual ? target.version !== manual : compareVersions(target.version, baseline) <= 0) return false;
    const old = seen.get(target.version);
    if (manual || !old || old.identity !== target.identity) return true;
    return ['retry', 'running'].includes(old.status) && old.attempts < 3 && now - old.updated >= 6 * 60 * 60 * 1000;
  }).sort((a, b) => compareVersions(a.version, b.version)).slice(0, 3).map(target => {
    const old = seen.get(target.version);
    return { ...target, issue: old?.issue ?? 0, attempts: old?.identity === target.identity ? old.attempts : 0 };
  });
}
export class FetchError extends Error {}
export async function request(url, { token, method = 'GET', body, responseType = 'json' } = {}) {
  const u = new URL(url);
  assert(u.protocol === 'https:' && ['api.github.com', 'registry.npmjs.org', 'download.deepseek.com'].includes(u.hostname), 'Untrusted upstream URL');
  let response;
  try {
    response = await fetch(u, { method, headers: { 'user-agent': 'dsh-session-bin-compatibility',
      ...(token && u.hostname === 'api.github.com' ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000), redirect: 'error' });
  } catch (error) { throw new FetchError(`Request failed: ${u.hostname}${u.pathname}: ${error.message}`); }
  if (!response.ok) throw new FetchError(`HTTP ${response.status}: ${u.hostname}${u.pathname}`);
  return responseType === 'text' ? response.text() : responseType === 'bytes' ? Buffer.from(await response.arrayBuffer()) : response.json();
}
export async function pages(path, token) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const data = await request(`https://api.github.com${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { token });
    assert(Array.isArray(data)); result.push(...data);
    if (data.length < 100) return result;
  }
  throw new FetchError('GitHub pagination limit reached');
}
export function assertRepository(repo) { assert(repo === 'takboo/dsh-session-bin', 'This automation only writes to takboo/dsh-session-bin'); return repo; }
export function aggregate(reports, expected) {
  if (reports.some(r => r?.status === 'failed')) return 'failed';
  if (reports.length !== expected || reports.some(r => !r || ['retry', 'running'].includes(r.status))) return 'retry';
  return reports.some(r => r.status === 'partial') ? 'partial' : 'passed';
}
export function subprocessStatus({ code, signal, error, timedOut, setup, log = '' }) {
  if (code === 0 && !signal && !error && !timedOut) return 'passed';
  if (error || timedOut || signal) return 'retry';
  if (/ERR_PNPM_TARBALL_INTEGRITY|integrity mismatch|supply.chain polic[^\n]*(?:fail|reject)|frozen.lockfile.*out.of.date/i.test(log)) return 'failed';
  if (setup || /EAI_AGAIN|ENETUNREACH|ECONNRESET|ETIMEDOUT|listen EPERM|kill EPERM|Operation not permitted|ENOSPC/.test(log)) return 'retry';
  return 'failed';
}
