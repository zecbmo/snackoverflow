import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Phase 4 receipts: paste a receipt, check the matches, add the whole shop to stock. */
test('add a whole shop from a pasted receipt', async ({ page }, info) => {
  // Cheddar: no other test scans it, so barcode linking can't mix the tests up.
  // Each project uses its own wording so learned matches from the other run don't change what's shown.
  const line = info.project.name === 'phone' ? 'TES MAT CHEDDAR 400G' : 'SAINS MATURE CHEDDAR 800G';
  await signIn(page);
  await page.goto('/receipts');
  await page.getByRole('button', { name: 'Paste text' }).click();
  await page.getByLabel('Receipt or order email').fill(`TESCO\n${line} 1.55\nCARRIER BAG 0.10\nTOTAL 1.65`);
  await page.getByRole('button', { name: 'Read it' }).click();

  await expect(page).toHaveURL(/\/receipts\/[0-9a-f-]+$/);
  await expect(page.getByText(line)).toBeVisible();
  // The bag is left out automatically; the cheese is matched to Cheddar.
  await expect(page.getByRole('checkbox', { name: 'Add CARRIER BAG' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: `Add ${line}` })).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'What it is' }).first()).toHaveValue(/^[pi]:/);

  await page.getByRole('button', { name: /Add 1 item to stock/ }).click();
  await expect(page).toHaveURL(/\/stock$/);
  await expect(page.getByText(/Added 1 to stock/)).toBeVisible();
  await expect(page.getByRole('button', { name: /cheddar/i }).first()).toBeVisible();
});
