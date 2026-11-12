import { expect, test } from '@playwright/test';
import { signIn, typeBarcode } from './helpers';

/** Key flow for phase 1: set up, scan food in (known and unknown barcodes), see it in stock, use it, undo. */

test('scan in, use and undo', async ({ page }, info) => {
  const milk = info.project.name === 'phone' ? 'Semi Skimmed Milk' : 'Chicken Thighs';
  const milkCode = info.project.name === 'phone' ? '5000000000017' : '5000000000024';
  const unknown = info.project.name === 'phone' ? '5000000000990' : '5000000000991';
  const unknownName = info.project.name === 'phone' ? 'Mystery jam' : 'Mystery chutney';

  await signIn(page);
  await page.goto('/scan');

  // Known barcode: looked up, added with an estimated date.
  await typeBarcode(page, milkCode);
  const card = page.getByRole('status').filter({ hasText: 'Added to Fridge' });
  await expect(card).toContainText(milk);
  await expect(card).toContainText('(estimated)');

  // Unknown barcode: a sheet asks what it is.
  await typeBarcode(page, unknown);
  await expect(page.getByRole('heading', { name: 'What is it?' })).toBeVisible();
  await page.getByLabel('Name').fill(unknownName);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`Everyone's phone will know ${unknownName} now.`)).toBeVisible();

  await expect(page.getByLabel('2 scanned')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Finish' }).click();

  // Both are in stock.
  await expect(page).toHaveURL(/\/stock$/);
  // Each row is a button that opens it ("Chicken Thighs, Fridge"), with its actions beside it.
  const row = (name: string) => page.getByRole('button', { name: new RegExp(`^${name}, `) });
  await expect(row(milk)).toBeVisible();
  await expect(row(unknownName)).toBeVisible();

  // Use it all straight from the row, then undo.
  await page.getByRole('button', { name: `Use ${milk}`, exact: true }).click();
  await page.getByRole('button', { name: 'Used it all' }).click();
  await expect(page.getByText(`Used up the ${milk}.`)).toBeVisible();
  await expect(row(milk)).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(row(milk)).toBeVisible();

  // The row opens its details in a side panel, linked from the address bar; Escape closes it.
  await row(milk).click();
  await expect(page).toHaveURL(/\?open=/);
  await expect(page.getByRole('dialog', { name: milk })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: milk })).toHaveCount(0);
});
