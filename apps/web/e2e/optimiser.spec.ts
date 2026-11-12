import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Phase 5 key flow: food about to go off pushes a recipe up "Use it up", into "Suggest meals" and into "Plan my week". */
test('use up food that is going off', async ({ page }, info) => {
  const title = `Salmon traybake ${info.project.name}`;
  await signIn(page);
  const { today } = await (await page.request.get('/api/session')).json();
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const ingredients = await (await page.request.get('/api/ingredients')).json();
  const salmon = ingredients.find((i: { key: string }) => i.key === 'salmon');
  await page.request.post('/api/recipes', {
    data: { title, serves: 2, ingredients: [{ text: '240g salmon fillets', amount: 240, unit: 'g', ingredientId: salmon.id }] },
  });
  // Two more recipes, so "Plan my week" has something to choose from (every recipe already planned is skipped).
  const pasta = ingredients.find((i: { key: string }) => i.key === 'pasta');
  for (const name of ['Pesto pasta', 'Pasta salad']) {
    await page.request.post('/api/recipes', {
      data: { title: `${name} ${info.project.name}`, serves: 2, ingredients: [{ text: '200g pasta', amount: 200, unit: 'g', ingredientId: pasta.id }] },
    });
  }
  const added = await (await page.request.post('/api/scan/add', { data: { barcode: '5000000000062' } })).json();
  await page.request.patch(`/api/stock/${added.change.item.id}`, { data: { bestBefore: tomorrow } });

  // Recipes: the "Use it up" tab says what it saves.
  await page.goto('/recipes');
  await page.getByRole('tab', { name: /Use it up/ }).click();
  await page.getByPlaceholder('Search recipes').fill(title);
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText('Uses salmon (tomorrow)').first()).toBeVisible();

  // Planner: "Suggest meals" offers it, and one tap plans it.
  await page.goto('/calendar');
  await page.getByRole('button', { name: 'Suggest meals' }).click();
  const sheet = page.getByRole('dialog', { name: 'Suggest meals' });
  await sheet.getByLabel('Day').selectOption(today);
  const idea = sheet.getByRole('listitem').filter({ hasText: title });
  await expect(idea).toBeVisible();
  await idea.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText(`${title} is planned for today.`)).toBeVisible();

  // "Plan my week" for a week nobody has planned yet: propose, drop one, save the rest.
  const weeksAhead = info.project.name === 'phone' ? 3 : 2;
  for (let i = 0; i < weeksAhead; i++) await page.getByRole('button', { name: 'Next week' }).click();
  await page.getByRole('button', { name: 'Plan my week' }).click();
  const week = page.getByRole('dialog', { name: 'Plan my week' });
  await week.getByRole('button', { name: 'Make a plan' }).click();
  const save = week.getByRole('button', { name: /^Add \d+ to plan$/ });
  await expect(save).toBeVisible();
  const before = Number((await save.textContent())!.match(/\d+/)![0]);
  expect(before).toBeGreaterThan(1);
  await week.getByRole('button', { name: 'Remove' }).first().click();
  await expect(save).toHaveText(`Add ${before - 1} to plan`);
  await save.click();
  await expect(page.getByText(`Planned ${before - 1} meals.`, { exact: false })).toBeVisible();
});
