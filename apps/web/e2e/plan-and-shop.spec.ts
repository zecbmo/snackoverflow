import { expect, test } from '@playwright/test';
import { signIn, typeBarcode } from './helpers';

/** Phase 4 key flow: plan a meal, build the shopping list in whole packs, tick it off and put it away; log a snack in Eat mode. */
test('plan a dinner, shop for it and put it away', async ({ page }, info) => {
  const title = `Pasta bake ${info.project.name}`;
  await signIn(page);
  const ingredients = await (await page.request.get('/api/ingredients')).json();
  const pasta = ingredients.find((i: { key: string }) => i.key === 'pasta');
  await page.request.post('/api/recipes', {
    data: { title, serves: 4, ingredients: [{ text: '400g penne', amount: 400, unit: 'g', ingredientId: pasta.id }] },
  });
  // The household has bought this pasta before, so put-away knows the product. None is left.
  const added = await (await page.request.post('/api/scan/add', { data: { barcode: '5000000000055' } })).json();
  await page.request.post(`/api/stock/${added.change.item.id}/use`, { data: { amount: { kind: 'all' } } });

  // Plan it for dinner today.
  await page.goto('/plan');
  await page.getByRole('button', { name: /^Add to dinner on Today/ }).click();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByText('4 servings')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByText('Added to the plan.')).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(title) }).first()).toBeVisible();

  // Build the list: sold in 500g packs.
  await page.getByRole('button', { name: 'Build shopping list' }).click();
  await expect(page).toHaveURL(/\/shop$/);
  const item = page.getByRole('checkbox', { name: /Got Pasta, .*500g/ });
  await expect(item).toBeVisible();
  await expect(page.getByText(new RegExp(title)).first()).toBeVisible();

  // Tick it off and put it away in one tap.
  await item.check();
  await page.getByRole('button', { name: /Put away 1 ticked item/ }).click();
  await expect(page.getByText(/Added \d+ to stock/)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.goto('/stock');
  await expect(page.getByRole('button', { name: /Penne Pasta/ }).first()).toBeVisible();

  // Eat mode: a snack logged to a meal, with its calories.
  await page.goto('/scan?mode=eat&slot=snack');
  await typeBarcode(page, '5000000000031');
  await expect(page.getByRole('status').filter({ hasText: 'Logged to your snack' })).toBeVisible();
});
