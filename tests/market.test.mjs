import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { verifyMarket } from '../scripts/verify-market.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-market-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = 'https://github.com/takboo/dsh-session-bin';
  const manifest = { name: '@takboo/dsh-session-bin', repository: { url: `git+${url}.git` },
    dsh: { bundle: { patch: './cordis.patch.yml' } }, exports: { './client': './dist/client.js' } };
  const entry = { url, name: 'takboo/dsh-session-bin', category: 'session',
    description: { en: 'Manage native archives.', zh: '管理原生归档。' },
    tarball: `${url}/releases/latest/download/dsh-session-bin.tgz` };
  const screenshots = ['images/archive.png'];
  await mkdir(join(root, 'market'));
  await mkdir(join(root, 'images'));
  await writeFile(join(root, 'cordis.patch.yml'), '- insert: []\n');
  await writeFile(join(root, screenshots[0]), 'fixture');
  const save = async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'market/takboo__dsh-session-bin.yml'), stringify(entry));
    await writeFile(join(root, 'screenshots.json'), JSON.stringify(screenshots));
  };
  await save();
  return { root, manifest, entry, screenshots, save };
}

test('a catalog entry links the npm repository and existing bundle and screenshots', async t => {
  const { root } = await fixture(t);
  const result = await verifyMarket(root);
  assert.equal(result.status, 'passed');
  assert.equal(result.package, '@takboo/dsh-session-bin');
  assert.equal(result.screenshots, 1);
});

test('publication metadata rejects broken install links and screenshot declarations', async t => {
  for (const [name, mutate, error] of [
    ['wrong repository', f => { f.entry.url += '-other'; }, /strictly equal/],
    ['manual npm mapping', f => { f.entry.npm = '@takboo/dsh-session-bin'; }, /Only catalog fields/],
    ['versioned latest asset', f => { f.entry.tarball = `${f.entry.url}/releases/latest/download/bin-0.2.0.tgz`; }, /version-free/],
    ['no bundle', f => { delete f.manifest.dsh.bundle; }, /installable dsh.bundle/],
    ['empty screenshots', f => { f.screenshots.length = 0; }, /1–8 screenshots/],
    ['escaping screenshot', f => { f.screenshots[0] = '../outside.png'; }, /inside the plugin directory/],
    ['missing screenshot', f => { f.screenshots[0] = 'images/missing.png'; }, /ENOENT/],
  ]) {
    await t.test(name, async child => {
      const f = await fixture(child);
      mutate(f);
      await f.save();
      await assert.rejects(verifyMarket(f.root), error);
    });
  }
});
