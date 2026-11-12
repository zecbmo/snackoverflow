import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Phase 6 key flow: set a calorie target, see days over it on the dashboard, and see what was binned. */
test('dashboard shows calories against a target and what was binned', async ({ page }, info) => {
  await signIn(page);
  const { today } = await (await page.request.get('/api/session')).json();
  // Each project uses its own day, since both share one household.
  const back = info.project.name === 'phone' ? 1 : 2;
  const day = new Date(Date.parse(`${today}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
  await page.request.post('/api/plan', { data: { date: day, slot: 'dinner', kind: 'text', text: 'Big dinner', kcalPerServing: 2400, eaten: true } });
  const added = await (await page.request.post('/api/scan/add', { data: { barcode: '5000000000062' } })).json();
  await page.request.post(`/api/stock/${added.change.item.id}/discard`, { data: {} });

  // Set a target in the profile.
  await page.goto('/profile');
  await page.getByLabel('Daily calorie target').fill('2000');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText('Saved.')).toBeVisible();

  await page.goto('/dashboard');
  await expect(page.getByText('Target 2,000')).toBeVisible();
  const label = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
  await expect(page.getByLabel(`${label}: 2,400 kcal, over target`)).toBeVisible();
  await page.getByRole('button', { name: '30 days' }).click();
  await expect(page.getByRole('heading', { name: 'Calories, last 30 days' })).toBeVisible();

  // Binned this month, then the full report.
  await expect(page.getByText('Salmon Fillets').first()).toBeVisible();
  await page.getByRole('link', { name: 'Waste report' }).last().click();
  await expect(page.getByRole('heading', { name: 'Waste report' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'By item, this month' })).toBeVisible();
  await page.getByRole('button', { name: 'By week' }).click();
  await expect(page.getByRole('heading', { name: 'By item, this week' })).toBeVisible();
});
