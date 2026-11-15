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

/** From the stock table: use one apple from a bag, and log it as eaten in the same step. */
test('use one from stock and log it as eaten', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const apples = phone ? 'Braeburn Apples' : 'Gala Apples';
  await signIn(page);
  await page.goto('/scan');
  await typeBarcode(page, phone ? '5000000000159' : '5000000000166');
  await expect(page.getByRole('status').filter({ hasText: apples })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page).toHaveURL(/\/stock$/);

  await page.getByRole('button', { name: `Use ${apples}`, exact: true }).click();
  const sheet = page.getByRole('dialog', { name: `Use ${apples}` });
  // Counted food: one at a time by default.
  await expect(sheet.getByRole('button', { name: 'Use 1 apple' })).toBeVisible();
  const log = sheet.getByRole('switch', { name: 'Log it as eaten' });
  if ((await log.getAttribute('aria-checked')) !== 'true') await log.click();
  await sheet.getByRole('radio', { name: 'Snack' }).click();
  await sheet.getByRole('button', { name: 'Use 1 apple' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Used some ${apples} and logged it to your snack.` })).toBeVisible();

  // Five left, and it's in today's diary.
  await expect(page.getByRole('button', { name: new RegExp(`^${apples}, `) }).locator('xpath=ancestor::*[self::tr or self::li][1]')).toContainText('5 apples');
  await page.goto('/');
  await expect(page.getByRole('region', { name: /food diary/ }).getByRole('region', { name: 'Snack' })).toContainText(apples);
});

/** Food measured by weight: grams (never thighs), quick amounts, and using more than the open pack has. */
test('use chicken thighs by weight across two packs', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const chicken = phone ? 'Free Range Chicken Thighs' : 'Corn Fed Chicken Thighs';
  const code = phone ? '5000000000173' : '5000000000180';
  await signIn(page);
  await page.goto('/scan');
  await typeBarcode(page, code);
  await expect(page.getByLabel('1 scanned')).toBeVisible();
  // The scanner ignores the same barcode twice within two seconds (no double beeps).
  await page.waitForTimeout(2100);
  await typeBarcode(page, code);
  await expect(page.getByLabel('2 scanned')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Finish' }).click();
  const row = page.getByRole('button', { name: new RegExp(`^${chicken}, `) }).locator('xpath=ancestor::*[self::tr or self::li][1]');
  await expect(row).toContainText('2kg');

  // The open pack: 300g left after using 700g.
  await page.getByRole('button', { name: `Use ${chicken}`, exact: true }).click();
  let sheet = page.getByRole('dialog', { name: `Use ${chicken}` });
  await expect(sheet).toContainText('2 packs · 2kg');
  await expect(sheet.getByRole('button', { name: /^Use \d+ thigh/ })).toHaveCount(0);
  await expect(sheet.getByRole('group', { name: 'Quick amounts' })).toContainText('500g');
  const log = sheet.getByRole('switch', { name: 'Log it as eaten' });
  if ((await log.getAttribute('aria-checked')) === 'true') await log.click();
  await sheet.getByLabel(/^Exact amount \(g\)/).fill('700');
  await sheet.getByRole('button', { name: 'Use', exact: true }).click();
  // Part of a closed pack: it asks whether it's opened now.
  await page.getByRole('dialog', { name: 'Is it opened now?' }).getByRole('button', { name: "Yes, it's open" }).click();
  await expect(row).toContainText('~1.3kg');

  // 500g is more than the open pack has: the rest comes from the next pack.
  await page.getByRole('button', { name: `Use ${chicken}`, exact: true }).click();
  sheet = page.getByRole('dialog', { name: `Use ${chicken}` });
  await sheet.getByRole('button', { name: 'Used 500g' }).click();
  await page.getByRole('dialog', { name: 'Is it opened now?' }).getByRole('button', { name: "Yes, it's open" }).click();
  await expect(row).toContainText('~800g');
  await expect(row).toContainText(phone ? '1 pack' : '1');
  // One Undo puts both packs back, and the second pack is closed again.
  await page.getByRole('status').filter({ hasText: `Used some ${chicken}` }).last().getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Undone.' })).toBeVisible();
  await expect(row).toContainText('~1.3kg');
  await expect(row).toContainText('2');
});
