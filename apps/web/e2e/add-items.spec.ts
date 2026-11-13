import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Adding stock by hand, several things at once, without a barcode. */
test('add several items to stock by hand', async ({ page }, info) => {
  const name = `Party rings ${info.project.name}`;
  await signIn(page);
  await page.goto('/stock?add=1');
  const sheet = page.getByRole('dialog', { name: 'Add items' });
  await expect(sheet).toBeVisible();

  // A food from the suggestions, and a brand-new name.
  const input = sheet.getByPlaceholder('Add an item and press Enter');
  await input.fill('carro');
  await sheet.getByRole('button', { name: 'Carrots', exact: true }).click();
  await input.fill(name);
  await input.press('Enter');
  await sheet.getByRole('textbox', { name: `Packs of ${name}` }).fill('2');
  await sheet.getByRole('button', { name: 'Add 3 to stock' }).click();

  await expect(page.getByText('Added 3 to stock.')).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(name) }).first()).toBeVisible();
});
