import { expect, test } from '@playwright/test';
import { signIn, typeBarcode } from './helpers';

/** Phone layout: recipes open the full page, the menu has the main pages, menus stay on screen. */
test('phone: full recipe page, menu and on-screen menus', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'Phone layout only');
  const title = `Phone pie with a long name that wraps onto more lines ${info.project.name}`;
  await signIn(page);
  await page.request.post('/api/recipes', { data: { title, serves: 2, ingredients: [{ text: '100g oats' }] } });

  // Tapping a recipe goes straight to the full recipe (no side panel), with Cook and Batch cook in reach.
  await page.goto('/recipes');
  await page.getByRole('button', { name: new RegExp(title) }).first().click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/);
  await expect(page.getByRole('link', { name: 'Cook', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Batch cook' })).toBeVisible();
  await page.mouse.wheel(0, 800);
  await expect(page.getByRole('link', { name: 'Cook', exact: true })).toBeInViewport();

  // The menu has the main pages, like the desktop sidebar.
  await page.goto('/');
  await page.getByRole('button', { name: /menu/i }).first().click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu.getByRole('link', { name: 'Scan items' })).toBeVisible();
  await expect(menu.getByRole('link', { name: /^Stock/ })).toBeVisible();
  await menu.getByRole('link', { name: 'Calendar' }).click();
  await expect(page).toHaveURL(/\/calendar$/);

  // A menu at the edge of the screen opens fully on it.
  await page.goto('/stock');
  await page.getByRole('button', { name: /^Filter/ }).first().click();
  const box = await page.getByRole('menu').first().boundingBox();
  const width = page.viewportSize()!.width;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
});

/** Stock on a phone: the page is exactly as wide as the screen, and a food's details start with its table row. */
test('phone: stock fits the screen and details show the table row', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'Phone layout only');
  await signIn(page);
  await page.goto('/scan');
  await typeBarcode(page, '5000000000210');
  await expect(page.getByLabel('1 scanned')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Finish' }).click();

  // Nothing pokes out past the right edge (a hidden label in the picker strip once did: the page slid sideways and the bottom bar shifted).
  await expect(page).toHaveURL(/\/stock/);
  const open = page.getByRole('button', { name: /^Orange Squash, / });
  await expect(open).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  // Where and how much, on the one line.
  await expect(open).toContainText(/· 1L$/);

  // The details start with what the desktop table shows for the row.
  await open.click();
  const row = page.getByRole('dialog', { name: 'Orange Squash' }).getByLabel('In stock');
  for (const [label, value] of [['Where', /\w+/], ['State', 'Closed'], ['Packs', '1'], ['Amount', '1L'], ['Planned', '–']] as const) {
    await expect(row.locator('div', { hasText: label }).first()).toContainText(value);
  }
});
