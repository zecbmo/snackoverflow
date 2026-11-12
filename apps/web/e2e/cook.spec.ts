import { expect, test } from '@playwright/test';
import { signIn, typeBarcode } from './helpers';

/** Phase 3 key flow: type a recipe in, cook it from stock, keep leftovers. */
test('cook a recipe from stock and keep leftovers', async ({ page }, info) => {
  const title = `Test chilli ${info.project.name}`;
  await signIn(page);

  // Some mince in the fridge.
  await page.goto('/scan');
  await typeBarcode(page, '5000000000048');
  await expect(page.getByRole('status').filter({ hasText: 'Added to' })).toBeVisible();

  // Type a recipe in.
  await page.goto('/recipes/new');
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Add ingredients').fill('250g beef mince\n1 onion, chopped');
  await page.getByRole('button', { name: 'Add lines' }).click();
  await expect(page.getByRole('combobox', { name: 'Matched ingredient' }).first()).toHaveValue(/.+/);
  await page.getByRole('button', { name: 'Save recipe' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  // Cook it: the mince comes out of stock; keep a portion.
  await page.getByRole('link', { name: 'Cook', exact: true }).click();
  await expect(page.getByText('Beef Mince', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'More portions' }).click();
  await page.getByRole('button', { name: /Cooked, keep 1/ }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Enjoy!')).toBeVisible();

  await page.goto('/meals');
  await expect(page.getByText(title).first()).toBeVisible();
  await expect(page.getByText('1 portion').first()).toBeVisible();
});
