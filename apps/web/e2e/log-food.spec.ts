import { expect, type Page, test } from '@playwright/test';
import { signIn, typeBarcode } from './helpers';

/** Phone: the centre "+" chooser. Desktop: the sidebar's Log food button. */
async function openLogFood(page: Page, phone: boolean) {
  if (phone) {
    await page.getByRole('button', { name: 'Add: log food, scan shopping or plan a meal' }).click();
    await page.getByRole('dialog', { name: 'What would you like to do?' }).getByRole('button', { name: /^Log food/ }).click();
  } else {
    await page.getByRole('complementary', { name: 'Main' }).getByRole('button', { name: 'Log food', exact: true }).click();
  }
  const sheet = page.getByRole('dialog', { name: 'Log food' });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Log a takeaway in four taps, then log a yoghurt from the fridge, answering the stock question. */
test('log food you ate: a takeaway, and something from stock', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const yoghurt = phone ? 'Strawberry Yoghurt' : 'Peach Yoghurt';
  await signIn(page);

  // A takeaway: + → Log food → search → pick → Log it.
  let sheet = await openLogFood(page, phone);
  await sheet.getByRole('textbox', { name: 'Search food' }).fill('barn burger');
  await sheet.getByRole('button', { name: /^Barn Burger/ }).click();
  await expect(page.getByRole('dialog', { name: 'How much?' })).toContainText('540 kcal');
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Logged Barn Burger to' })).toBeVisible();
  await page.keyboard.press('Escape');
  const diary = page.getByRole('region', { name: /food diary/ });
  await expect(diary.getByRole('link', { name: /Barn Burger/ }).first()).toBeVisible();

  // A yoghurt from the fridge: the app asks whether to take it from stock.
  await page.goto('/scan');
  await typeBarcode(page, phone ? '5000000000111' : '5000000000128');
  await expect(page.getByRole('status').filter({ hasText: yoghurt })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.goto('/');
  sheet = await openLogFood(page, phone);
  await sheet.getByRole('textbox', { name: 'Search food' }).fill(yoghurt);
  await sheet.getByRole('button', { name: new RegExp(`^${yoghurt}`) }).first().click();
  const amount = page.getByRole('dialog', { name: 'How much?' });
  await expect(amount).toContainText('Take it from stock?');
  await amount.getByRole('button', { name: 'Log and take it' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Logged ${yoghurt} to` })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/stock');
  await expect(page.getByRole('button', { name: new RegExp(`^${yoghurt}, `) })).toHaveCount(0);
});

/** Something planned for today shows dashed in the diary; "Ate it" ticks it off. */
test('tick off a planned meal from the diary', async ({ page }, info) => {
  const title = info.project.name === 'phone' ? 'Afternoon toast' : 'Afternoon flapjack';
  await signIn(page);
  const session = await (await page.request.get('/api/session')).json();
  const res = await page.request.post('/api/plan', { data: { date: session.today, slot: 'snack', kind: 'text', text: title, kcalPerServing: 250, people: [{ userId: session.user.id, portions: 1 }] } });
  expect(res.ok()).toBe(true);
  await page.goto('/');
  const diary = page.getByRole('region', { name: /food diary/ });
  const row = diary.getByRole('listitem').filter({ hasText: title });
  await expect(row).toContainText('Planned');
  await row.getByRole('button', { name: 'Ate it', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: `You had the ${title.toLowerCase()}.` })).toBeVisible();
  await expect(row.getByRole('button', { name: `Untick ${title} (eaten)` })).toBeVisible();
  await expect(row).not.toContainText('Planned');
});

/** Open Food Facts by name, a favourite, a barcode nobody knows, and a saved meal. */
test('find food anywhere, star it, name a new barcode and save a meal', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const bar = phone ? 'Nutty Choc Bar' : 'Crunchy Choc Bar';
  const samosa = phone ? 'Corner shop samosa' : 'Market stall pasty';
  await signIn(page);

  // Not one of ours yet: ask Open Food Facts.
  let sheet = await openLogFood(page, phone);
  await sheet.getByRole('textbox', { name: 'Search food' }).fill(bar.toLowerCase());
  await sheet.getByRole('button', { name: `Search Open Food Facts for "${bar.toLowerCase()}"` }).click();
  await sheet.getByRole('button', { name: new RegExp(`^${bar}`) }).click();
  let amount = page.getByRole('dialog', { name: 'How much?' });
  await expect(amount).toContainText('Protein');
  await amount.getByRole('button', { name: `Add ${bar} to favourites` }).click();
  await expect(amount.getByRole('button', { name: `Remove ${bar} from favourites` })).toBeVisible();
  await amount.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Logged ${bar} to` })).toBeVisible();
  // Back on search, with it in Favourites.
  sheet = page.getByRole('dialog', { name: 'Log food' });
  await expect(sheet.getByRole('region', { name: 'Favourites' }).getByRole('button', { name: new RegExp(bar) })).toBeVisible();

  // A barcode nobody knows: name it, with its calories.
  await sheet.getByRole('button', { name: 'Scan a barcode' }).first().click();
  const scan = page.getByRole('dialog', { name: 'Scan a barcode' });
  await scan.getByLabel('Or type the barcode').fill(phone ? '2000000000015' : '2000000000022');
  await scan.getByRole('button', { name: 'Find it' }).click();
  const name = page.getByRole('dialog', { name: 'What is it?' });
  await name.getByLabel('Name').fill(samosa);
  await name.getByLabel('Pack size (optional)').fill('120');
  await name.getByLabel('Calories in the whole pack (optional)').fill('300');
  await name.getByRole('button', { name: 'Save and continue' }).click();
  amount = page.getByRole('dialog', { name: 'How much?' });
  await expect(amount).toContainText('300 kcal');
  await amount.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Logged ${samosa} to` })).toBeVisible();
  await page.keyboard.press('Escape');

  // Save that meal from the diary, then it's one tap in Log food.
  const meal = page.getByRole('region', { name: /food diary/ }).getByRole('region').filter({ hasText: samosa });
  await meal.getByRole('button', { name: /^Save .* as a meal$/ }).click();
  const save = page.getByRole('dialog', { name: 'Save as a meal' });
  await save.getByLabel('Name').fill(`${samosa} combo`);
  await save.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Saved ${samosa} combo.` })).toBeVisible();
  sheet = await openLogFood(page, phone);
  await sheet.getByRole('region', { name: 'Your meals' }).getByRole('button', { name: new RegExp(`^${samosa} combo`) }).click();
  await page.getByRole('dialog', { name: 'Log a meal' }).getByRole('button', { name: 'Log only, ate it elsewhere' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Logged ${samosa} combo to` })).toBeVisible();
});
