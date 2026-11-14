import { expect, test } from '@playwright/test';
import { signIn, typeBarcode } from './helpers';

/** A 1×1 PNG: the e2e server's pretend AI reads anything. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const photo = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG });

test('fill in an unknown product from a photo of its pack', async ({ page }, info) => {
  const code = info.project.name === 'phone' ? '5000000000992' : '5000000000993';
  await signIn(page);
  await page.goto('/scan');
  await typeBarcode(page, code);
  await expect(page.getByRole('heading', { name: 'What is it?' })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles([photo('front.png'), photo('label.png')]);
  await expect(page.getByText('Filled in from the photo, with the label’s nutrition. Check it, then save.')).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('Oat Drink');
  await expect(page.getByLabel('Pack size')).toHaveValue('1');
  await expect(page.getByLabel('Brand')).toHaveValue('Oaty');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText("Everyone's phone will know Oat Drink now.")).toBeVisible();
});

test('add recipe photos and read them all into recipes', async ({ page }) => {
  await signIn(page);
  await page.goto('/recipes/photos');
  await page.getByRole('button', { name: 'All one recipe (front and back)' }).click();
  await page.locator('input[type="file"]').setInputFiles([photo('front.png'), photo('back.png')]);
  await expect(page.getByText('Added. It’s waiting to be read.')).toBeVisible();
  await expect(page.getByText('Waiting to be read').first()).toBeVisible();
  await page.getByRole('button', { name: /^Read (it|all \d+) with AI$/ }).click();
  // Read in the background, then it's a recipe.
  await expect(page.getByRole('link', { name: 'Tomato pasta from a card' }).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: 'Tomato pasta from a card' }).first().click();
  await expect(page.getByRole('heading', { name: 'Tomato pasta from a card' })).toBeVisible();
  await expect(page.getByText('200g penne pasta')).toBeVisible();
});
