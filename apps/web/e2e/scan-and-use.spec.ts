import { expect, type Page, test } from '@playwright/test';

/** Key flow for phase 1: set up, scan food in (known and unknown barcodes), see it in stock, use it, undo. */

async function signIn(page: Page) {
  await page.goto('/');
  // A fresh server needs setup; the second project finds it done and signs in.
  const heading = page.getByRole('heading', { level: 1, name: /^(Welcome|Sign in)$/ });
  await expect(heading).toBeVisible();
  if ((await heading.textContent()) === 'Welcome') {
    await page.getByLabel('Household name').fill('Test house');
    await page.getByLabel('Your name').fill('Alex');
    await page.getByLabel('Email').fill('alex@example.com');
    await page.getByLabel('Password').fill('a long password');
    await page.getByRole('button', { name: 'Create household' }).click();
  } else {
    await page.getByLabel('Email').fill('alex@example.com');
    await page.getByLabel('Password').fill('a long password');
    await page.getByRole('button', { name: 'Sign in' }).click();
  }
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
}

async function typeBarcode(page: Page, code: string) {
  await page.getByRole('button', { name: 'Type a barcode' }).click();
  await page.getByRole('textbox', { name: 'Barcode' }).fill(code);
  await page.getByRole('button', { name: 'Scan it' }).click();
}

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
  await expect(page.getByRole('button', { name: new RegExp(milk) })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(unknownName) })).toBeVisible();

  // Use it all, then undo.
  await page.getByRole('button', { name: new RegExp(milk) }).click();
  await page.getByRole('button', { name: 'Use', exact: true }).click();
  await page.getByRole('button', { name: 'Used it all' }).click();
  await expect(page.getByText(`Used up the ${milk}.`)).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(milk) })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: new RegExp(milk) })).toBeVisible();
});
