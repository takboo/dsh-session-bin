import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
async function walk(directory) {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isFile()) files.push(path);
    else if (entry.isDirectory()) await walk(path);
  }
}
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.md')) files.push(entry.name);
}
for (const directory of ['docs', '.github']) await walk(directory);
const errors = [];
const optional = new Set();
let links = 0;
let snapshots = 0;
const headings = new Map();
function inside(path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}
function anchors(source) {
  const seen = new Map(); const result = new Set(); let fence = false;
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    const match = !fence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = match[1].replace(/[`*]/g, '').toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = seen.get(base) ?? 0; seen.set(base, count + 1);
    result.add(count ? `${base}-${count}` : base);
  }
  return result;
}
for (const file of files.filter(file => file.endsWith('.md'))) {
  let source;
  try { source = await readFile(resolve(root, file), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; } // staged deletion
  for (const match of source.matchAll(/\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    let target = match[1].replace(/^<|>$/g, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    target = decodeURIComponent(target);
    const [path, anchor] = target.split('#');
    const absolute = resolve(dirname(resolve(root, file)), path || file.split('/').at(-1));
    if (!inside(absolute)) { errors.push(`${file}: outside repository: ${target}`); continue; }
    links += 1;
    try { await access(absolute); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (relative(root, absolute).replaceAll('\\', '/').startsWith('.local/')) optional.add(target);
      else errors.push(`${file}: missing ${target}`);
      continue;
    }
    if (anchor && absolute.endsWith('.md') && !/^L\d+(?:-L\d+)?$/.test(anchor)) {
      if (!headings.has(absolute)) headings.set(absolute, anchors(await readFile(absolute, 'utf8')));
      if (!headings.get(absolute).has(anchor)) errors.push(`${file}: missing anchor ${target}`);
    }
  }
}
for (const file of files.filter(file => file.startsWith('docs/archive/') && file.endsWith('/manifest.json'))) {
  const manifest = JSON.parse(await readFile(resolve(root, file), 'utf8'));
  for (const entry of manifest.files) {
    const path = resolve(root, dirname(file), entry.snapshot);
    assert(inside(path), 'Archive snapshot must stay in repository');
    const bytes = await readFile(path);
    assert.equal(bytes.length, entry.bytes, `${entry.source}: archive size changed`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.source}: archive bytes changed`);
    snapshots += 1;
  }
}
assert.equal(errors.length, 0, errors.join('\n'));
console.log(JSON.stringify({ status: 'passed', localLinks: links, snapshots,
  unavailableLocalEvidence: optional.size, limits: 'Checks local documents and preserved bytes; does not query external URLs or recreate historical .local evidence.' }, null, 2));
