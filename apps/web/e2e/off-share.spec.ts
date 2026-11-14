import { expect, test } from '@playwright/test';
import { signIn, typeBarcode } from './helpers';

/** Naming an unknown barcode and adding it to Open Food Facts (the test server has a pretend account). */
test('name a new product and add it to Open Food Facts', async ({ page }, info) => {
  // Valid barcodes the fake Open Food Facts doesn't know, one per project.
  const code = info.project.name === 'phone' ? '5000000000999' : '5000000000982';
  const name = info.project.name === 'phone' ? 'Damson jam' : 'Piccalilli';

  await signIn(page);
  await page.goto('/scan');
  await typeBarcode(page, code);
  await expect(page.getByRole('heading', { name: 'What is it?' })).toBeVisible();
  await page.getByLabel('Name').fill(name);

  const share = page.getByRole('checkbox', { name: /Add it to Open Food Facts too/ });
  await expect(share).not.toBeChecked();
  await share.check();
  await page.getByLabel('Brand').fill('Hedgerow Kitchen');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Added to Open Food Facts. Thanks for helping!')).toBeVisible();
});
