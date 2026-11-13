import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Who's eating: one icon per serving; only your own portions count for your calories; a batch cook counts for nobody. */
test('take a free portion of a planned meal, then make it a batch cook', async ({ page }, info) => {
  const title = `Oat bake ${info.project.name}`;
  await signIn(page);
  const session = await (await page.request.get('/api/session')).json();
  const ingredients = await (await page.request.get('/api/ingredients')).json();
  const oats = ingredients.find((i: { key: string }) => i.key === 'oats');
  const recipe = await (
    await page.request.post('/api/recipes', {
      data: { title, serves: 2, tags: ['breakfast'], ingredients: [{ text: '100g oats', amount: 100, unit: 'g', ingredientId: oats.id }] },
    })
  ).json();
  const today = session.today as string;
  // Three servings, one of them mine.
  await page.request.post('/api/plan', {
    data: { date: today, slot: 'breakfast', kind: 'recipe', recipeId: recipe.id, servings: 3, people: [{ userId: session.user.id, portions: 1 }] },
  });

  await page.goto(`/calendar?date=${today}`);
  await page.getByRole('button', { name: new RegExp(title) }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Portions: you, 2 free')).toBeVisible();

  // Take a free one: now two are mine.
  await sheet.getByRole('button', { name: /Portion 2: free/ }).click();
  await page.getByRole('menuitemradio', { name: 'You' }).click();
  await expect(sheet.getByText('Portions: you, 1 free')).toBeVisible();

  // A batch cook is for the freezer: nobody's eating it now.
  await sheet.getByRole('checkbox', { name: /Batch cook/ }).check();
  await expect(sheet.getByText(/Nobody: it's a batch cook/)).toBeVisible();
});
