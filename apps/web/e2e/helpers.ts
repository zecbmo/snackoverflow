import { expect, type Page } from '@playwright/test';

export async function signIn(page: Page) {
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

export async function typeBarcode(page: Page, code: string) {
  await page.getByRole('button', { name: 'Type a barcode' }).click();
  await page.getByRole('textbox', { name: 'Barcode' }).fill(code);
  await page.getByRole('button', { name: 'Scan it' }).click();
}

