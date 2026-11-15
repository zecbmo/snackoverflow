#!/usr/bin/env node
/**
 * Resets a test copy of Snack Overflow to made-up demo data: the same as Settings → General →
 * Reset test data. It deletes the household's food data (meals, stock, recipes, products, the
 * shopping list, receipts…) and fills it with two more people, ~38 products with prices, stock
 * (some going off, some opened, some binned), a dozen recipes, two weeks of eaten meals, the next
 * week planned, a batch cook in the freezer, a shopping list and receipts.
 *
 *   node --env-file=.env.test scripts/demo-data.mjs
 *
 * The server must have TEST_MODE=true (it refuses otherwise, so a real household is safe).
 * Settings: SO_URL (default http://localhost:$PORT), ADMIN_EMAIL, ADMIN_PASSWORD.
 */

const PORT = process.env.PORT ?? '3080';
const BASE = (process.env.SO_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (for example: node --env-file=.env.test scripts/demo-data.mjs).');
  process.exit(1);
}

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (!login.ok) throw new Error(`Couldn't sign in as ${EMAIL} (${login.status}): ${await login.text()}`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  console.log(`Signed in to ${BASE} as ${EMAIL}. Resetting the test data (a few seconds)...`);
  const res = await fetch(`${BASE}/api/test-data/reset`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  const text = await res.text();
  if (!res.ok) throw new Error(`Reset refused (${res.status}): ${text.slice(0, 300)}`);
  for (const step of JSON.parse(text).steps) console.log(`  ${step}`);
  console.log(`Done. Open ${BASE} to look around. Sam and Jo sign in with the password "demo password 123".`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
