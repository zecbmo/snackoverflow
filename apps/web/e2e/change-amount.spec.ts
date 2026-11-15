import { expect, type Page, test } from '@playwright/test';
import { signIn, typeBarcode } from './helpers';

async function scanIn(page: Page, code: string, name: string, times: number) {
  await page.goto('/scan');
  for (let i = 0; i < times; i++) {
    await typeBarcode(page, code);
    await expect(page.getByLabel(`${i + 1} scanned`)).toBeVisible();
  }
  await expect(page.getByRole('status').filter({ hasText: name })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page).toHaveURL(/\/stock$/);
}

/** Change how much is left with the − / + stepper, merge two packs into one, and remove a pack. */
test('change the amount, merge and remove packs', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const name = phone ? 'Mature Cheddar' : 'Red Leicester';
  const code = phone ? '5000000000098' : '5000000000104';
  const openSheet = async (amount: string) => {
    // Desktop: click the amount in the table. Phone: it's in the row's "⋯" menu.
    if (phone) {
      await page.getByRole('button', { name: `More for ${name}` }).click();
      await page.getByRole('menuitem', { name: 'Change amount…' }).click();
    } else {
      await page.getByRole('button', { name: `Change amount of ${name}, ${amount}` }).click();
    }
    const sheet = page.getByRole('dialog', { name });
    await expect(sheet).toBeVisible();
    return sheet;
  };
  const rowText = () => page.getByRole('button', { name: new RegExp(`^${name}, `) }).locator('xpath=ancestor::*[self::tr or self::li][1]');

  await signIn(page);
  await scanIn(page, code, name, 1);

  let sheet = await openSheet('400g');
  const amount = sheet.getByRole('textbox', { name: 'Amount left in grams' });
  await expect(amount).toHaveValue('400');
  await sheet.getByRole('button', { name: 'Take off 100g' }).click();
  await sheet.getByRole('button', { name: 'Take off 10g' }).click();
  await sheet.getByRole('button', { name: 'Take off 10g' }).click();
  await expect(amount).toHaveValue('280');
  await sheet.getByRole('button', { name: 'Add 10g' }).click();
  await expect(amount).toHaveValue('290');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`Updated the ${name}.`)).toBeVisible();
  await expect(rowText()).toContainText('~290g');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(rowText()).not.toContainText('~');

  // A second pack: merge the two into one 800g pack.
  await scanIn(page, code, name, 1);
  await expect(rowText()).toContainText('800g');
  sheet = await openSheet('800g');
  await expect(sheet.getByRole('group', { name: /^Pack 1/ })).toBeVisible();
  await expect(sheet.getByRole('group', { name: /^Pack 2/ })).toBeVisible();
  await sheet.getByRole('button', { name: 'Merge into one' }).click();
  await expect(page.getByText(`Merged 2 packs of ${name} into one.`)).toBeVisible();
  await expect(sheet.getByRole('textbox', { name: 'Amount left in grams' })).toHaveValue('800');

  // Remove it (not counted as waste), then bring it back.
  await sheet.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(`Removed the ${name}.`)).toBeVisible();
  await expect(rowText()).toHaveCount(0);
  await page.getByRole('status').filter({ hasText: `Removed the ${name}.` }).getByRole('button', { name: 'Undo' }).click();
  await expect(rowText()).toContainText('800g');
});
