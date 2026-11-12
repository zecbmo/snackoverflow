import { expect, test } from '@playwright/test';
import { signIn, typeBarcode } from './helpers';

/** Scans made with no signal are kept on the phone and added when it reconnects. */
test('scans offline and syncs when back online', async ({ page, context }, info) => {
  const code = info.project.name === 'phone' ? '5000000000031' : '5000000000017';
  const name = info.project.name === 'phone' ? 'Baked Beans' : 'Semi Skimmed Milk';
  await signIn(page);
  await page.goto('/scan');

  await context.setOffline(true);
  await typeBarcode(page, code);
  await expect(page.getByRole('status').filter({ hasText: 'Saved offline' })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText(/Synced 1 scan made offline/)).toBeVisible({ timeout: 15_000 });

  await page.goto('/stock');
  await expect(page.getByRole('button', { name: new RegExp(name) }).first()).toBeVisible();
});
