import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Short of red peppers but have mushrooms: pick the swap on the recipe, plan it, and the calendar remembers. */
test('swap an ingredient for one in the same swap group, and plan it', async ({ page }, info) => {
  const title = `Swap traybake ${info.project.name}`;
  const groupName = `Traybake veg ${info.project.name}`;
  await signIn(page);
  const ingredients = (await (await page.request.get('/api/ingredients')).json()) as { id: string; name: string }[];
  const id = (name: string) => ingredients.find((i) => i.name === name)!.id;
  // Mushrooms in the fridge (no other test uses them).
  await page.request.post('/api/stock/add-many', { data: { items: [{ ingredientId: id('Mushrooms') }] } });

  // Peppers and mushrooms can stand in for each other in this house.
  await page.goto('/swap-groups');
  await page.getByLabel('New group').fill(groupName);
  await page.getByRole('button', { name: 'Add group' }).click();
  const add = page.getByLabel(`Add a food to ${groupName}`);
  await add.selectOption(id('Red peppers'));
  await expect(page.getByRole('button', { name: `Take Red peppers out of ${groupName}` })).toBeVisible();
  await add.selectOption(id('Mushrooms'));
  await expect(page.getByRole('button', { name: `Take Mushrooms out of ${groupName}` })).toBeVisible();

  // A recipe that wants peppers.
  await page.goto('/recipes/new');
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Add ingredients').fill('300g red peppers');
  await page.getByRole('button', { name: 'Add lines' }).click();
  await expect(page.getByRole('combobox', { name: 'Matched ingredient' }).first()).toHaveValue(id('Red peppers'));
  await page.getByRole('button', { name: 'Save recipe' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  // A close (yellow) swap: use the mushrooms.
  await page.getByRole('button', { name: 'Close swaps for Red peppers' }).click();
  await page.getByRole('button', { name: /^Mushrooms .* in$/ }).click();
  await expect(page.getByText('Using mushrooms instead')).toBeVisible();

  // Not a good fit? ✕ takes it away for this food (here undone straight after).
  await page.getByRole('button', { name: 'Close swaps for Red peppers' }).click();
  await page.getByRole('button', { name: "Mushrooms isn't a swap for red peppers" }).click();
  const toast = page.getByRole('status').filter({ hasText: "Mushrooms won't be offered for red peppers again." });
  await expect(toast).toBeVisible();
  // Gone from the swaps; Undo brings it back.
  await expect(page.getByRole('button', { name: 'Close swaps for Red peppers' })).toHaveCount(0);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Close swaps for Red peppers' }).click();
  await page.getByRole('button', { name: /^Mushrooms .* in$/ }).click();
  await expect(page.getByText('Using mushrooms instead')).toBeVisible();

  // Plan it: the swap goes with it.
  await page.getByRole('button', { name: 'More for this recipe' }).click();
  await page.getByRole('menuitem', { name: 'Add to calendar…' }).click();
  await expect(page.getByText('With swaps: Mushrooms for red peppers.')).toBeVisible();
  await page.getByRole('button', { name: 'Add to plan' }).click();
  await expect(page.getByText(`${title} is planned for`)).toBeVisible();

  const { today } = await (await page.request.get('/api/session')).json();
  const plan = await (await page.request.get(`/api/plan?from=${today}&to=${today}`)).json();
  const entry = plan.days[0].entries.find((e: { title: string }) => e.title === title);
  expect(entry.swaps).toEqual([expect.objectContaining({ from: 'Red peppers', to: 'Mushrooms' })]);
  await page.goto('/calendar');
  await expect(page.getByText('With mushrooms for red peppers').first()).toBeVisible();

  // Tidy up so other tests' calendars stay as they expect.
  await page.request.delete(`/api/plan/${entry.id}`);
});
