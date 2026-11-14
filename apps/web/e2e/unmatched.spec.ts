import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** A recipe line that isn't in the catalogue gets fixed from Settings → Unmatched ingredients. */
test('fix an unmatched recipe line with a new ingredient', async ({ page }, info) => {
  const food = `Smoked paprika ${info.project.name}`;
  const title = `Paprika eggs ${info.project.name}`;
  await signIn(page);

  await page.goto('/recipes/new');
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Add ingredients').fill(`1 sachet ${food}`);
  await page.getByRole('button', { name: 'Add lines' }).click();
  await expect(page.getByText('Pick an ingredient to link it to your stock')).toBeVisible();
  await page.getByRole('button', { name: 'Save recipe' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  await page.goto('/unmatched');
  await expect(page.getByRole('heading', { name: 'Unmatched ingredients' })).toBeVisible();
  await page.getByRole('button', { name: `Fix ${food}`, exact: false }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByText(`1 sachet ${food}`)).toBeVisible();
  await panel.getByRole('button', { name: 'A new ingredient' }).click();
  await expect(panel.getByLabel('Name')).toHaveValue(new RegExp(food, 'i'));
  await panel.getByLabel('Name').fill(food);
  await panel.getByLabel('Category').selectOption('Herbs & Spices');
  await panel.getByLabel('Grams per sachet').fill('5');
  await panel.getByRole('button', { name: 'Link 1 line' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Linked 1 line.' })).toBeVisible();

  // Linked and weighed; next it needs nutrition, so recipes' calories can count it.
  await page.getByRole('button', { name: `Fix ${food}`, exact: false }).click();
  await expect(panel.getByText('No nutrition', { exact: false }).first()).toBeVisible();
  await panel.getByLabel('Calories (kcal)').fill('282');
  await panel.getByLabel('Protein (g)').fill('14');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expect(page.getByRole('button', { name: `Fix ${food}`, exact: false })).toHaveCount(0);

  // The recipe now knows it, and what it weighs.
  await page.goto('/ingredients');
  await expect(page.getByText(food).first()).toBeVisible();
});
