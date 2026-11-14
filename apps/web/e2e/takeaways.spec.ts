import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Settings → Fast food & takeaways: browse the chains, open one's menu, and search every menu. (Data: test/fixtures/chains.) */
test('browse chain menus and search across them', async ({ page }) => {
  await signIn(page);
  await page.goto('/takeaways');
  await expect(page.getByRole('heading', { name: 'Fast food & takeaways' })).toBeVisible();
  await expect(page.getByText('3 chains · 2 with menus · 9 menu items')).toBeVisible();

  // Only the chains with a menu.
  await page.getByRole('button', { name: /^Filter/ }).click();
  await page.getByRole('menuitemradio', { name: 'No menu yet' }).click();
  await expect(page.getByRole('button', { name: 'Pizza Place menu' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Burger Barn menu' })).toHaveCount(0);
  await page.getByRole('button', { name: /^Filter/ }).click();
  await page.getByRole('menuitemradio', { name: 'All chains' }).click();

  // One chain's menu, sorted by calories, and an item's full nutrition.
  await page.getByRole('button', { name: 'Burger Barn menu' }).click();
  await expect(page.getByRole('heading', { name: 'Burger Barn' })).toBeVisible();
  await expect(page.getByRole('link', { name: /example\.com/ })).toHaveAttribute('href', 'https://example.com/burger-barn/nutrition');
  await page.getByRole('button', { name: /^Sort/ }).click();
  await page.getByRole('menuitemradio', { name: 'Most calories' }).click();
  await page.getByRole('button', { name: /^Group/ }).click();
  await page.getByRole('menuitemradio', { name: 'No grouping' }).click();
  await expect(page.getByRole('button', { name: /, nutrition$/ }).first()).toHaveAccessibleName('Barn Burger, nutrition');
  await page.getByRole('button', { name: 'Chips (Large), nutrition' }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('heading', { name: 'Chips (Large)' })).toBeVisible();
  await expect(panel.getByRole('row', { name: /^Energy 440 kcal 293 kcal$/ })).toBeVisible();
  await expect(panel.getByRole('row', { name: /^Salt 0.8g 0.53g$/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // Search every menu, by the chain's nickname too.
  await page.goto('/takeaways');
  await page.getByRole('button', { name: 'Menu items' }).click();
  await page.getByRole('searchbox', { name: 'Search every menu' }).fill('bb chips');
  await expect(page.getByRole('button', { name: /, nutrition$/ })).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Search every menu' }).fill('chips');
  await expect(page.getByRole('button', { name: /, nutrition$/ })).toHaveCount(3);
  await page.getByRole('button', { name: 'Chips (Small), Noodle Bar, nutrition' }).click();
  await expect(page.getByRole('dialog').getByRole('row', { name: /^Fat Not published$/ })).toBeVisible();
  await page.getByRole('link', { name: "See Noodle Bar's full menu" }).click();
  await expect(page.getByRole('heading', { name: 'Noodle Bar' })).toBeVisible();
});
