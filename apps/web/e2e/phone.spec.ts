import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

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
