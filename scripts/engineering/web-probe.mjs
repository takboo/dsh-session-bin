import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { archiveSession, panel, panelEntry, showAllSessions } from '../gui-archive-actions.mjs';
import { fixtures, openSdkFixture } from '../gui-fixture.mjs';

const ui = {
  panel: 'Session Bin', entries: 'Archived conversations', search: 'Search archives',
  archive: 'Archive session', restore: 'Unarchive', viewOptions: 'View options',
  showArchived: 'All conversations (show archived)', flat: 'In one list',
};
const button = (root, name) => root.getByRole('button', { name, exact: true });

export async function prepareHost({ dshHome, fixtureDir }) {
  const paths = {
    primary: join(fixtureDir, 'workspace'), secondary: join(fixtureDir, 'second-workspace'),
    sessions: join(dshHome, 'sessions'), storages: join(dshHome, 'storages'),
  };
  await Promise.all([paths.primary, paths.secondary].map(path => mkdir(path)));
  // rc.3 installs the exact npm host in a sibling directory of its isolated DSH_HOME.
  const sdk = createRequire(join(dirname(dshHome), 'host', 'package.json'));
  const fixture = await openSdkFixture(paths, true, sdk);
  await fixture.close();
}

export async function prepareClient(page) {
  const welcome = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
  await button(welcome, 'Continue').click();
  await welcome.waitFor({ state: 'hidden' });
  const modelSetup = page.getByRole('dialog', { name: 'Get started', exact: true });
  await button(modelSetup, 'Close').click();
  await modelSetup.waitFor({ state: 'hidden' });
}

export async function verifyClient(page) {
  await page.waitForFunction(() => window.__DSH_BOOT__?.entries?.some(entry => entry.id === '@takboo/dsh-session-bin'));
  await showAllSessions(page, ui);
  const root = await panel(page, ui);
  const [quiet, sibling, nativeOnly, prearchived] = fixtures;
  for (const item of [nativeOnly, prearchived]) await panelEntry(root, item.title, ui).waitFor();
  const target = panelEntry(root, quiet.title, ui);
  assert.equal(await target.count(), 0);
  await archiveSession(page, quiet.id, ui);
  await target.waitFor();

  const deletion = page.getByRole('dialog', { name: `Permanently delete “${quiet.title}”?`, exact: true });
  await button(target, `Permanently delete ${quiet.title}`).click();
  await deletion.getByText('Permanent deletion is not supported by this Host and storage combination.', { exact: true }).waitFor();
  assert.equal(await button(deletion, 'Delete permanently').isEnabled(), false);
  await button(deletion, 'Cancel').click();
  await deletion.waitFor({ state: 'hidden' });
  await button(target, ui.restore).click();
  await target.waitFor({ state: 'hidden' });
  const row = page.locator(`[data-row-key="session:${quiet.id}"]`).first();
  await row.locator(':scope:not([aria-description])').waitFor();
  for (const item of [nativeOnly, prearchived]) await panelEntry(root, item.title, ui).waitFor();
  assert.equal(await panelEntry(root, sibling.title, ui).count(), 0);
  return [
    'installed Session Bin client shows preexisting native archives',
    'native Archive updates Session Bin',
    'the unqualified container disables deletion and the fixture remains restorable',
    'Session Bin unarchive clears the native mark and preserves the other archives',
  ];
}
