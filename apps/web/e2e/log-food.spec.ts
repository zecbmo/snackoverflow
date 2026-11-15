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
  await expect(diary.getByRole('button', { name: /Barn Burger/ }).first()).toBeVisible();

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

/** From the stock table: one apple from a bag, with "I ate it", is out of stock and in the diary in one step. */
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
  // Counted food: by the apple. A quick amount only fills it in; one line says what it will do.
  await sheet.getByRole('group', { name: 'Quick amounts' }).getByRole('button', { name: '1 apple', exact: true }).click();
  await expect(sheet.getByLabel(/^How much/)).toHaveValue('1');
  await expect(sheet).toContainText('Leaves about 5 apples.');
  // "I ate it" is its own button (no switch to remember), for the meal you pick.
  await expect(sheet.getByRole('switch')).toHaveCount(0);
  await sheet.getByLabel('Meal to log it to').selectOption('snack');
  await sheet.getByRole('button', { name: /^I ate 1 apple/ }).click();
  await expect(page.getByRole('status').filter({ hasText: `Logged 1 apple of ${apples} to your snack.` })).toBeVisible();

  // Five left, and it's in today's diary.
  await expect(page.getByRole('button', { name: new RegExp(`^${apples}, `) }).locator('xpath=ancestor::*[self::tr or self::li][1]')).toContainText('5 apples');
  await page.goto('/');
  await expect(page.getByRole('region', { name: /food diary/ }).getByRole('region', { name: 'Snack' })).toContainText(apples);
});

/** A diary line owns the food it took: change how much you had on Today, then remove it, and stock follows each time. */
test('eat from stock, change the amount on Today, then remove it', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const turkey = phone ? 'Turkey Breast Strips' : 'Turkey Breast Mince';
  await signIn(page);
  await page.goto('/scan');
  await typeBarcode(page, phone ? '5000000000197' : '5000000000203');
  await expect(page.getByRole('status').filter({ hasText: turkey })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page).toHaveURL(/\/stock$/);
  const left = async () => {
    const stock = (await (await page.request.get('/api/stock')).json()) as { productName: string; remainingGrams: number }[];
    return stock.filter((s) => s.productName === turkey).reduce((n, s) => n + s.remainingGrams, 0);
  };

  // "I ate it": out of stock and into the diary in one step.
  await page.getByRole('button', { name: `Use ${turkey}`, exact: true }).click();
  const sheet = page.getByRole('dialog', { name: `Use ${turkey}` });
  await sheet.getByLabel(/^How much \(g\)/).fill('150');
  await expect(sheet).toContainText('Leaves about 350g.');
  await sheet.getByLabel('Meal to log it to').selectOption('lunch');
  await sheet.getByRole('button', { name: /^I ate 150g/ }).click();
  await expect(page.getByRole('status').filter({ hasText: `Logged 150g of ${turkey} to your lunch.` })).toBeVisible();
  expect(await left()).toBe(350);

  // On Today the line says how much, in grams, and opens its sheet in place.
  await page.goto('/');
  const lunch = page.getByRole('region', { name: /food diary/ }).getByRole('region', { name: 'Lunch' });
  await expect(lunch).toContainText('150g · 165 kcal');
  await lunch.getByRole('button', { name: `${turkey}: change or remove` }).click();
  const line = page.getByRole('dialog', { name: turkey });
  await expect(line).toContainText('From stock');
  // Had more: the extra comes out of stock, and the sheet says so.
  await line.getByRole('button', { name: 'More' }).click();
  await expect(line).toContainText('50g more taken from stock.');
  await expect(line).toContainText('220 kcal');
  expect(await left()).toBe(300);
  // Remove it: everything it took goes back.
  await line.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Removed. 200g put back in stock.' })).toBeVisible();
  expect(await left()).toBe(500);
  await expect(lunch).not.toContainText(turkey);
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
  // One amount for the row; the packs are a link for anyone who wants them.
  await expect(sheet).toContainText('2kg left');
  await expect(sheet.getByRole('button', { name: '2 packs' })).toBeVisible();
  const quick = sheet.getByRole('group', { name: 'Quick amounts' });
  await expect(quick).toContainText('500g');
  await expect(quick).not.toContainText('thigh');
  await sheet.getByLabel(/^How much \(g\)/).fill('700');
  await expect(sheet).toContainText('Opens a pack and leaves about 300g in it. 1.3kg left in all.');
  await sheet.getByRole('button', { name: /^Just use 700g/ }).click();
  // Part of a closed pack: it's opened without asking, and the toast says so.
  await expect(page.getByRole('status').filter({ hasText: `Used 700g of ${chicken}. 1.3kg left. It's open now` })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Is it opened now?' })).toHaveCount(0);
  await expect(row).toContainText('~1.3kg');
  // Nothing in the diary: a use is just a use.

  // 500g is more than the open pack has: the sheet says what that means before anything happens.
  await page.getByRole('button', { name: `Use ${chicken}`, exact: true }).click();
  sheet = page.getByRole('dialog', { name: `Use ${chicken}` });
  await sheet.getByRole('group', { name: 'Quick amounts' }).getByRole('button', { name: '500g', exact: true }).click();
  await expect(sheet).toContainText('Finishes the open pack and takes 200g from the next. 800g left.');
  await sheet.getByRole('button', { name: /^Just use 500g/ }).click();
  await expect(row).toContainText('~800g');
  await expect(row).toContainText(phone ? '1 pack' : '1');
  // One Undo puts both packs back, and the second pack is closed again.
  await page.getByRole('status').filter({ hasText: `Used 500g of ${chicken}` }).last().getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Undone.' })).toBeVisible();
  await expect(row).toContainText('~1.3kg');
  await expect(row).toContainText('2');
});
