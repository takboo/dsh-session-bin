import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { parseDocument } from 'yaml';

const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function repositoryFile(root, path) {
  assert.equal(typeof path, 'string', 'Repository resources require relative paths.');
  assert(path && !isAbsolute(path) && !path.includes('\\') && !path.split('/').includes('..'),
    'Repository resources must stay inside the plugin directory.');
  const resolved = await realpath(join(root, path));
  const local = relative(root, resolved);
  assert(local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`),
    'Repository resources must stay inside the plugin directory.');
  assert((await stat(resolved)).isFile(), 'Repository resources must be files.');
}

// This is an offline publication check, not the catalog's age gate or review.
export async function verifyMarket(root = process.cwd()) {
  root = await realpath(root);
  const manifest = await json(join(root, 'package.json'));
  const url = manifest.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '');
  assert(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url ?? ''),
    'npm repository must identify the listed GitHub repository.');
  const name = new URL(url).pathname.slice(1);
  const file = `market/${name.replace('/', '__')}.yml`;
  const document = parseDocument(await readFile(join(root, file), 'utf8'));
  assert.deepEqual(document.errors, [], 'Catalog YAML must be valid, with no duplicate keys.');
  const entry = document.toJS();
  assert.deepEqual(Object.keys(entry).sort(), ['category', 'description', 'name', 'tarball', 'url'],
    'Only catalog fields belong in the submission; npm is linked automatically.');
  assert.equal(entry.url, url);
  assert.equal(entry.name, name);
  assert.equal(entry.category, 'session');
  assert.equal(entry.tarball, `${url}/releases/latest/download/dsh-session-bin.tgz`,
    'The fallback must use the stable, version-free release asset name.');
  for (const [locale, ending] of [['en', '.'], ['zh', '。']]) {
    const description = entry.description?.[locale];
    assert(typeof description === 'string' && description.trim() && !/[\r\n]/.test(description)
      && description.endsWith(ending), `${locale} description must be a sentence ending in ${ending}`);
  }
  assert(manifest.dsh?.bundle?.patch, 'An installable dsh.bundle is required.');
  await repositoryFile(root, manifest.dsh.bundle.patch);
  assert(manifest.exports?.['./client'], 'The browser entry must be exported.');
  const declaration = await json(join(root, 'screenshots.json'));
  const screenshots = Array.isArray(declaration) ? declaration : declaration.screenshots;
  assert(Array.isArray(screenshots) && screenshots.length >= 1 && screenshots.length <= 8,
    'Declare 1–8 screenshots next to package.json.');
  assert.equal(new Set(screenshots).size, screenshots.length, 'Screenshot paths must be distinct.');
  for (const screenshot of screenshots) await repositoryFile(root, screenshot);
  return { status: 'passed', entry: file, repository: url, package: manifest.name,
    tarball: entry.tarball, screenshots: screenshots.length,
    scope: 'Offline entry, npm repository, bundle patch, and screenshot checks; catalog age gate and maintainer review remain external.' };
}

if (import.meta.main) console.log(JSON.stringify(await verifyMarket(), null, 2));
