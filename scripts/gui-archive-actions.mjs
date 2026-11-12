import assert from 'node:assert/strict';

const button = (root, name) => root.getByRole('button', { name, exact: true });
const menuItem = (root, name) => root.getByRole('menuitem', { name, exact: true });
const textbox = (root, name) => root.getByRole('textbox', { name, exact: true });
const text = (root, value) => root.getByText(value, { exact: true });

async function clickChoice(page, label) {
  const choice = menuItem(page, label);
  if (await choice.count()) await choice.click();
  else await text(page, label).click();
}
export async function showAllSessions(page, ui) {
  await button(page, ui.viewOptions).click();
  await clickChoice(page, ui.showArchived);
  await button(page, ui.viewOptions).click();
  await clickChoice(page, ui.flat);
}
export async function rowMenu(page, id) {
  const row = page.locator(`[data-row-key="session:${id}"]`).first();
  await row.waitFor({ state: 'visible' });
  await row.hover();
  const anchor = row.getByRole('button').first();
  await anchor.click();
  return anchor;
}
export async function archiveSession(page, id, ui) {
  await rowMenu(page, id);
  assert.equal(await menuItem(page, 'Move to Session Bin').count(), 0);
  assert.equal(await menuItem(page, '移入回收站').count(), 0);
  await menuItem(page, ui.archive).click();
  await page.locator(`[data-row-key="session:${id}"][aria-description]`).first().waitFor({ state: 'visible' });
}
export async function panel(page, ui) {
  const search = textbox(page, ui.search);
  await button(page, ui.panel).waitFor({ state: 'visible' });
  if (!await search.isVisible()) await button(page, ui.panel).click();
  await search.waitFor({ state: 'visible' });
  return page.getByRole('region', { name: ui.panel, exact: true });
}
export function panelEntry(root, title, ui) {
  return root.getByRole('list', { name: ui.entries, exact: true }).getByRole('listitem').filter({ has: root.page().getByText(title, { exact: true }) });
}
