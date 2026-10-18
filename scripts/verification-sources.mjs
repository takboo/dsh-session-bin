import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** The same implementation inventory for standalone and Desktop qualification. */
export async function captureSources(root) {
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  for (const path of ['src', 'tests', 'scripts', '.github', 'market']) await walk(join(root, path));
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'mise.toml', 'tsconfig.json', 'tsconfig.client.json', 'screenshots.json']) files.push(join(root, path));
  const inventory = [];
  for (const path of files) inventory.push({ path: relative(root, path).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  inventory.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { inventory, sha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex') };
}
