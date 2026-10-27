// Adapted from dsh-usage-state's discover.mjs; Copyright (c) 2026 takboo (MIT).
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { compareVersions, digest, pages, request, version, versionPattern, assertRepository, FetchError } from './common.mjs';
import { selectChecks } from './planning.mjs';
export const desktopFeed = 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml';
export function parseDesktopFeed(source) {
  const scalar = key => {
    const lines = source.split(/\r?\n/);
    const index = lines.findIndex(line => line.startsWith(`${key}:`));
    assert(index >= 0, `Desktop feed is missing ${key}`);
    let value = lines[index].slice(key.length + 1).trim();
    if (/^[>|][-+]?$/.test(value)) { assert(/^\s+\S/.test(lines[index + 1] ?? '')); value = lines[index + 1].trim(); }
    return value.replace(/^['"]|['"]$/g, '');
  };
  const desktop = { version: version(scalar('version')), sha512: scalar('sha512'), path: scalar('path') };
  assert(/^[A-Za-z\d+/]{80,}={0,2}$/.test(desktop.sha512));
  const url = new URL(desktop.path);
  assert(url.origin === 'https://download.deepseek.com' && url.pathname.startsWith('/dsh-desk/bin/mac-arm64/'));
  return desktop;
}
export function combineTargets(registry, releases, desktop, baseline, manual = '') {
  const all = new Map();
  const add = v => {
    if (!versionPattern.test(v ?? '')) return;
    if (!all.has(v)) all.set(v, { version: v, channels: [] });
    return all.get(v);
  };
  for (const channel of ['latest', 'next']) {
    const t = add(registry['dist-tags']?.[channel]); if (t) t.channels.push(`npm:${channel}`);
  }
  for (const release of releases) {
    if (release.draft || !release.published_at || !/^dsh-v/.test(release.tag_name)) continue;
    const t = add(release.tag_name.slice(5));
    if (t) { t.channels.push('github'); t.release = { id: release.id, tag: release.tag_name, publishedAt: release.published_at }; }
  }
  if (manual) add(version(manual.replace(/^dsh-v/, '')));
  const d = add(desktop.version);
  if (d) { d.channels.push('desktop:mac-arm64'); d.desktop = { version: desktop.version, sha512: desktop.sha512, path: desktop.path }; }
  return [...all.values()].filter(t => manual ? t.version === manual.replace(/^dsh-v/, '') : compareVersions(t.version, baseline) > 0).map(t => {
    const pkg = registry.versions?.[t.version];
    if (!pkg?.dist?.integrity || !registry.time?.[t.version]) {
      if (!t.release && !t.desktop) throw new FetchError(`Exact npm version is not published: ${t.version}`);
      t.npm = { publishedAt: 'not yet available', integrity: null, tarball: null };
      t.identity = digest({ version: t.version, release: t.release ?? null, desktop: t.desktop ?? null, npm: null });
      return t;
    }
    const tarball = new URL(pkg.dist.tarball);
    assert(tarball.origin === 'https://registry.npmjs.org' && tarball.pathname === `/@deepseek-ai/dsh/-/dsh-${t.version}.tgz`);
    t.npm = { publishedAt: registry.time[t.version], tarball: tarball.href, integrity: pkg.dist.integrity, ...( /^[a-f\d]{40}$/.test(pkg.gitHead ?? '') ? { commit: pkg.gitHead } : {} ) };
    t.channels.sort();
    t.identity = digest({ version: t.version, npm: t.npm, release: t.release ?? null, desktop: t.desktop ?? null });
    return t;
  });
}
export async function discover({ manual = '', token, repo, local = false, pullRequest = false } = {}) {
  const baseline = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).engines.dsh;
  const [registry, releases, feed, issues] = await Promise.all([
    request('https://registry.npmjs.org/@deepseek-ai%2Fdsh'),
    pages('/repos/deepseek-ai/deepseek-harness/releases', token),
    request(desktopFeed, { responseType: 'text' }),
    local ? [] : pages(`/repos/${assertRepository(repo)}/issues?state=all`, token),
  ]);
  const normalized = manual.replace(/^dsh-v/, '');
  const targets = combineTargets(registry, releases, parseDesktopFeed(feed), baseline, normalized);
  for (const target of targets) if (target.release) {
    const commit = await request(`https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/${encodeURIComponent(target.release.tag)}`, { token });
    assert(/^[a-f\d]{40}$/.test(commit.sha)); target.commit = commit.sha;
  }
  for (const target of targets) target.identity = digest({ version: target.version, npm: target.npm, release: target.release ?? null, desktop: target.desktop ?? null, commit: target.commit ?? null });
  const selected = selectChecks(targets, issues, { baseline, manual: normalized, pullRequest });
  if (manual) assert.equal(selected.length, 1, 'Exact published target not found');
  return selected;
}
async function main() {
  const targets = await discover({ manual: process.env.DSH_VERSION ?? '', token: process.env.GH_TOKEN,
    repo: process.env.GITHUB_REPOSITORY, local: process.argv.includes('--local') || process.env.GITHUB_EVENT_NAME === 'pull_request',
    pullRequest: process.env.GITHUB_EVENT_NAME === 'pull_request' });
  if (process.env.DSH_TARGET_FILE) await writeFile(process.env.DSH_TARGET_FILE, JSON.stringify(targets[0], null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `matrix=${JSON.stringify({ include: targets })}\ncount=${targets.length}\n`
    + `sdk_matrix=${JSON.stringify({ include: targets.filter(t => t.runSdk) })}\nsdk_count=${targets.filter(t => t.runSdk).length}\n`
    + `desktop_matrix=${JSON.stringify({ include: targets.filter(t => t.runDesktop) })}\ndesktop_count=${targets.filter(t => t.runDesktop).length}\n`);
  console.log(JSON.stringify(targets, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
