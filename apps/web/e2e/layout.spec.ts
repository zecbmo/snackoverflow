import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** The desktop shell and tables: a sidebar that collapses to icons (and stays that way), and ticking rows to act on several at once. */
test('sidebar collapses to icons and remembers it', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'The sidebar is desktop only; phones use the bottom bar and menu.');
  await signIn(page);
  const sidebar = page.getByRole('complementary', { name: 'Main' });
  await expect(sidebar.getByRole('link', { name: 'Recipes' })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  // Icons only, but every link keeps its name for screen readers.
  await expect(sidebar.getByRole('link', { name: 'Recipes' })).toBeVisible();
  await expect(sidebar.getByText('Food', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.keyboard.press('[');
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
});

test('bin several things at once and undo', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'Ticking rows is a desktop table feature.');
  await signIn(page);
  for (const barcode of ['5000000000079', '5000000000086']) await page.request.post('/api/scan/add', { data: { barcode } });
  await page.goto('/stock');
  await page.getByRole('checkbox', { name: /^Select Greek Yogurt/ }).check();
  await page.getByRole('checkbox', { name: /^Select Houmous/ }).check();
  const bar = page.getByRole('region', { name: 'Selected rows' });
  await expect(bar).toContainText('2 selected');
  await bar.getByRole('button', { name: 'Bin' }).click();
  await expect(page.getByText('Binned 2 packs.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Greek Yogurt, / })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /^Greek Yogurt, / })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Houmous, / })).toBeVisible();
});
