#!/usr/bin/env node
/**
 * Fills a Snack Overflow server with made-up demo data, through the app's own API:
 * two more people, ~35 products with prices, stock across fridge, freezer and cupboard
 * (some going off, some opened, some binned), a dozen recipes, two weeks of eaten meals,
 * the next week planned, a batch cook in the freezer, a shopping list and a receipt.
 *
 *   node --env-file=.env.test scripts/demo-data.mjs
 *
 * Settings: SO_URL (default http://localhost:$PORT), ADMIN_EMAIL, ADMIN_PASSWORD.
 * Everything is fictional. Run it on a test copy, not your real household: it refuses
 * if the demo recipes are already there, unless you pass --force.
 */

const PORT = process.env.PORT ?? '3080';
const BASE = (process.env.SO_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const FORCE = process.argv.includes('--force');
if (!EMAIL || !PASSWORD) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (for example: node --env-file=.env.test scripts/demo-data.mjs).');
  process.exit(1);
}

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && path === '/api/auth/login') cookie = setCookie.split(';')[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const get = (p) => call('GET', p);
const post = (p, b = {}) => call('POST', p, b);
const patch = (p, b) => call('PATCH', p, b);

const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// --- The data ------------------------------------------------------------------------------

// [name, brand, ingredient key, pack amount, pack unit, kcal per 100g, price in pence]
const PRODUCTS = [
  ['Semi Skimmed Milk', 'Meadow Farm', 'milk', 2.272, 'l', 46, 155],
  ['Free Range Eggs', 'Happy Hens', 'eggs', 360, 'g', 143, 225],
  ['Mature Cheddar', 'Valley Dairy', 'cheddar', 400, 'g', 416, 375],
  ['Salted Butter', 'Meadow Farm', 'butter', 250, 'g', 744, 210],
  ['Greek Style Yogurt', 'Olympus', 'greek_yogurt', 500, 'g', 133, 135],
  ['Double Cream', 'Meadow Farm', 'double_cream', 300, 'ml', 467, 120],
  ['Wholemeal Bread', 'Hearth Bakery', 'bread', 800, 'g', 247, 135],
  ['Chicken Thighs', null, 'chicken_thighs', 1, 'kg', 177, 450],
  ['Chicken Breast Fillets', null, 'chicken_breast', 650, 'g', 106, 525],
  ['Beef Mince 5% Fat', null, 'beef_mince', 500, 'g', 137, 400],
  ['Pork Sausages', 'Old Spot', 'sausages', 454, 'g', 290, 300],
  ['Smoked Back Bacon', 'Old Spot', 'bacon', 300, 'g', 215, 275],
  ['Salmon Fillets', null, 'salmon', 240, 'g', 208, 450],
  ['King Prawns', null, 'prawns', 180, 'g', 70, 350],
  ['Baby Spinach', null, 'spinach', 200, 'g', 23, 100],
  ['Brown Onions', null, 'onions', 1, 'kg', 40, 99],
  ['Garlic', null, 'garlic', 250, 'g', 149, 70],
  ['Carrots', null, 'carrots', 1, 'kg', 41, 55],
  ['Red Peppers', null, 'red_pepper', 450, 'g', 31, 120],
  ['Closed Cup Mushrooms', null, 'mushrooms', 300, 'g', 22, 95],
  ['Vine Tomatoes', null, 'tomatoes', 500, 'g', 18, 140],
  ['Maris Piper Potatoes', null, 'potatoes', 2.5, 'kg', 77, 129],
  ['Bananas', null, 'bananas', 1, 'kg', 89, 85],
  ['Penne Pasta', 'Nonna', 'pasta', 500, 'g', 357, 75],
  ['Basmati Rice', 'Tilda Fields', 'rice', 1, 'kg', 350, 199],
  ['Chopped Tomatoes', 'Nonna', 'chopped_tomatoes', 400, 'g', 21, 45],
  ['Chickpeas', null, 'chickpeas', 400, 'g', 120, 55],
  ['Red Lentils', null, 'lentils', 500, 'g', 340, 95],
  ['Porridge Oats', 'Highland', 'oats', 1, 'kg', 375, 89],
  ['Olive Oil', 'Nonna', 'olive_oil', 500, 'ml', 824, 450],
  ['Garden Peas', null, 'frozen_peas', 900, 'g', 81, 130],
  ['Oven Chips', null, 'oven_chips', 1.5, 'kg', 160, 175],
  ['Vanilla Ice Cream', 'Dairy Dream', 'ice_cream', 900, 'g', 200, 250],
  ['Basil Pesto', 'Nonna', 'pesto', 190, 'g', 520, 150],
  ['Tuna Chunks', null, 'tinned_tuna', 145, 'g', 110, 100],
  ['Baked Beans', null, 'baked_beans', 415, 'g', 78, 75],
];

// [product, location type, packs, best-before in days from today (null: estimate), open it?]
const STOCK = [
  ['Semi Skimmed Milk', 'fridge', 1, 5, false],
  ['Semi Skimmed Milk', 'fridge', 1, 1, true],
  ['Free Range Eggs', 'fridge', 1, 12, false],
  ['Mature Cheddar', 'fridge', 1, 20, true],
  ['Salted Butter', 'fridge', 1, 30, true],
  ['Greek Style Yogurt', 'fridge', 1, 2, true],
  ['Double Cream', 'fridge', 1, 3, false],
  ['Chicken Thighs', 'fridge', 1, 1, false],
  ['Beef Mince 5% Fat', 'fridge', 2, 2, false],
  ['Smoked Back Bacon', 'fridge', 1, 6, false],
  ['Salmon Fillets', 'fridge', 1, 0, false],
  ['Baby Spinach', 'fridge', 1, 1, false],
  ['Closed Cup Mushrooms', 'fridge', 1, 3, false],
  ['Red Peppers', 'fridge', 1, 5, false],
  ['Vine Tomatoes', 'fridge', 1, 4, false],
  ['Carrots', 'fridge', 1, 10, false],
  ['Wholemeal Bread', 'cupboard', 1, 3, true],
  ['Brown Onions', 'cupboard', 1, 21, false],
  ['Garlic', 'cupboard', 1, 25, false],
  ['Maris Piper Potatoes', 'cupboard', 1, 14, false],
  ['Bananas', 'cupboard', 1, 2, false],
  ['Penne Pasta', 'cupboard', 2, 300, false],
  ['Basmati Rice', 'cupboard', 1, 400, true],
  ['Chopped Tomatoes', 'cupboard', 3, 600, false],
  ['Chickpeas', 'cupboard', 2, 500, false],
  ['Red Lentils', 'cupboard', 1, 365, false],
  ['Porridge Oats', 'cupboard', 1, 200, true],
  ['Olive Oil', 'cupboard', 1, 365, true],
  ['Basil Pesto', 'cupboard', 1, 120, false],
  ['Tuna Chunks', 'cupboard', 2, 700, false],
  ['Baked Beans', 'cupboard', 2, 650, false],
  ['Garden Peas', 'freezer', 1, null, false],
  ['Oven Chips', 'freezer', 1, null, false],
  ['Vanilla Ice Cream', 'freezer', 1, null, false],
  ['King Prawns', 'freezer', 1, null, false],
  ['Chicken Breast Fillets', 'freezer', 1, null, false],
  ['Pork Sausages', 'freezer', 1, null, false],
];

// Binned today, for the waste report: [product, location, best-before offset, fraction binned]
const BINNED = [
  ['Baby Spinach', 'fridge', -1, 1],
  ['Wholemeal Bread', 'cupboard', -2, 0.5],
  ['Double Cream', 'fridge', -1, 1],
  ['Bananas', 'cupboard', -1, 0.5],
];

// [title, serves, prep, cook, tags, [[text, grams, ingredient key, unit?]], steps]
const RECIPES = [
  ['Chicken & spinach curry', 4, 15, 30, ['dinner', 'curry', 'freezes well'], [['600g chicken thighs, diced', 600, 'chicken_thighs'], ['1 large onion, sliced', 150, 'onions'], ['3 garlic cloves, crushed', 15, 'garlic'], ['400g tin chopped tomatoes', 400, 'chopped_tomatoes'], ['200g baby spinach', 200, 'spinach'], ['300g basmati rice', 300, 'rice']], ['Fry the onion in a little oil until soft and golden, about 10 minutes.', 'Add the garlic and curry spices, cook for a minute, then add the chicken and brown it all over.', 'Pour in the tomatoes, simmer for 20 minutes until the chicken is cooked through.', 'Stir in the spinach until wilted. Serve with the rice.']],
  ['Beef chilli', 4, 15, 45, ['dinner', 'freezes well'], [['500g beef mince', 500, 'beef_mince'], ['1 onion, chopped', 150, 'onions'], ['1 red pepper, chopped', 150, 'red_pepper'], ['2 garlic cloves', 10, 'garlic'], ['400g tin chopped tomatoes', 400, 'chopped_tomatoes'], ['400g tin chickpeas, drained', 240, 'chickpeas'], ['300g basmati rice', 300, 'rice']], ['Brown the mince in a large pan, then lift out.', 'Soften the onion, pepper and garlic, then add chilli powder and cumin.', 'Return the mince, add the tomatoes and chickpeas, and simmer for 40 minutes.', 'Serve with rice and a spoon of yogurt.']],
  ['Pasta bake', 4, 10, 30, ['dinner', 'family'], [['400g penne', 400, 'pasta'], ['400g tin chopped tomatoes', 400, 'chopped_tomatoes'], ['200g mushrooms, sliced', 200, 'mushrooms'], ['1 onion, chopped', 100, 'onions'], ['120g mature cheddar, grated', 120, 'cheddar']], ['Cook the pasta for 2 minutes less than the packet says.', 'Fry the onion and mushrooms, add the tomatoes and simmer for 10 minutes.', 'Mix with the pasta, tip into a dish, cover with cheese and bake at 200°C for 20 minutes.']],
  ['Salmon traybake', 2, 10, 35, ['dinner', 'quick'], [['2 salmon fillets', 240, 'salmon'], ['500g potatoes, cut into wedges', 500, 'potatoes'], ['200g vine tomatoes', 200, 'tomatoes'], ['1 tbsp olive oil', 15, 'olive_oil']], ['Roast the potato wedges in the oil at 200°C for 20 minutes.', 'Add the salmon and tomatoes to the tray and roast for 12–15 minutes more.']],
  ['Red lentil dahl', 4, 10, 30, ['dinner', 'veggie', 'freezes well'], [['250g red lentils', 250, 'lentils'], ['1 onion, chopped', 150, 'onions'], ['2 garlic cloves', 10, 'garlic'], ['400g tin chopped tomatoes', 400, 'chopped_tomatoes'], ['100g spinach', 100, 'spinach']], ['Soften the onion and garlic with curry spices.', 'Add the lentils, tomatoes and 700ml water; simmer for 25 minutes, stirring now and then.', 'Stir through the spinach and season well.']],
  ['Full English', 2, 5, 20, ['breakfast', 'weekend'], [['4 sausages', 227, 'sausages'], ['4 rashers back bacon', 120, 'bacon'], ['2 eggs', 120, 'eggs'], ['100g mushrooms', 100, 'mushrooms'], ['2 tomatoes, halved', 120, 'tomatoes'], ['200g baked beans', 200, 'baked_beans']], ['Grill the sausages for 15 minutes, turning, and add the bacon for the last 6.', 'Fry the mushrooms and tomatoes; warm the beans.', 'Fry the eggs and serve everything at once.']],
  ['Porridge with banana', 2, 2, 5, ['breakfast', 'quick'], [['80g porridge oats', 80, 'oats'], ['400ml milk', 400, 'milk'], ['1 banana, sliced', 120, 'bananas']], ['Simmer the oats in the milk for 4–5 minutes, stirring.', 'Top with the banana.']],
  ['Prawn pesto pasta', 2, 5, 12, ['dinner', 'quick'], [['200g penne', 200, 'pasta'], ['180g king prawns', 180, 'prawns'], ['3 tbsp pesto', 60, 'pesto'], ['60g spinach', 60, 'spinach']], ['Cook the pasta.', 'Fry the prawns until pink, then stir in the pesto, spinach and drained pasta.']],
  ['Tuna & chickpea salad', 2, 10, 0, ['lunch', 'quick'], [['145g tin tuna, drained', 145, 'tinned_tuna'], ['400g tin chickpeas, drained', 240, 'chickpeas'], ['150g tomatoes, chopped', 150, 'tomatoes'], ['½ red pepper, diced', 80, 'red_pepper']], ['Mix everything in a bowl with a squeeze of lemon and a little olive oil.']],
  ['Sausage & mash', 4, 10, 30, ['dinner', 'family'], [['8 pork sausages', 454, 'sausages'], ['1kg potatoes', 1000, 'potatoes'], ['2 onions, sliced', 200, 'onions'], ['30g butter', 30, 'butter'], ['100ml milk', 100, 'milk'], ['200g frozen peas', 200, 'frozen_peas']], ['Bake the sausages at 200°C for 25 minutes.', 'Boil the potatoes until tender, then mash with the butter and milk.', 'Cook the onions slowly for gravy, and the peas for 3 minutes.']],
  ['Cheese & tomato toastie', 1, 3, 5, ['lunch', 'quick'], [['2 slices bread', 80, 'bread'], ['50g cheddar, grated', 50, 'cheddar'], ['1 tomato, sliced', 50, 'tomatoes']], ['Fill the bread with cheese and tomato and toast in a dry pan until golden on both sides.']],
  ['Cottage pie', 6, 20, 60, ['dinner', 'freezes well', 'family'], [['500g beef mince', 500, 'beef_mince'], ['900g potatoes', 900, 'potatoes'], ['2 carrots, diced', 200, 'carrots'], ['1 onion, chopped', 150, 'onions'], ['150g frozen peas', 150, 'frozen_peas'], ['30g butter', 30, 'butter']], ['Brown the mince with the onion and carrots, add stock and simmer for 30 minutes; stir in the peas.', 'Boil and mash the potatoes with the butter.', 'Top the mince with the mash and bake at 200°C for 25 minutes.']],
];

const RECEIPT = (date) => `GREENWAYS SUPERMARKET
SEMI SKIMMED MILK 4PT        1.55
FREE RANGE EGGS 6            2.25
MATURE CHEDDAR 400G          3.75
CHICKEN THIGHS 1KG           4.50
BABY SPINACH 200G            1.00
BROWN ONIONS 1KG             0.99
2 x CHOPPED TOMATOES 400G    0.90
BASMATI RICE 1KG             1.99
CARRIER BAG                  0.10
TOTAL                       16.93
${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

// --- Fill it --------------------------------------------------------------------------------

async function main() {
  await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
  const session = await get('/api/session');
  const today = session.today;
  const me = session.user;
  console.log(`Signed in to ${BASE} as ${me.name} (${session.household.name}). Today is ${today}.`);

  const existing = await get('/api/recipes');
  if (existing.some((r) => r.title === RECIPES[0][0]) && !FORCE) {
    console.error('The demo recipes are already there. Pass --force to add everything again.');
    process.exit(1);
  }

  await patch('/api/household', { settings: { pricingEnabled: true } });

  // People.
  const people = [me];
  for (const [name, email, target] of [
    ['Sam', 'sam@example.com', 2400],
    ['Jo', 'jo@example.com', 1800],
  ]) {
    const users = await get('/api/users');
    let u = users.find((x) => x.email === email);
    if (!u) {
      const inv = await post('/api/invites', { role: 'member' });
      const token = inv.url.split('/invite/')[1];
      const res = await fetch(`${BASE}/api/invites/${token}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, email, password: 'demo password 123' }) });
      if (!res.ok) throw new Error(`Couldn't add ${name}: ${await res.text()}`);
      u = (await get('/api/users')).find((x) => x.email === email);
    }
    await patch(`/api/users/${u.id}`, { kcalTarget: target });
    people.push(u);
  }
  await patch('/api/me', { kcalTarget: 2000 });
  console.log(`People: ${people.map((p) => p.name).join(', ')}`);

  // Products, with prices.
  const ingredients = await get('/api/ingredients');
  const ing = (key) => {
    const i = ingredients.find((x) => x.key === key);
    if (!i) throw new Error(`No ingredient ${key}`);
    return i.id;
  };
  const products = {};
  for (const [name, brand, key, amount, unit, kcal, pence] of PRODUCTS) {
    const p = await post('/api/products', { name, brand, ingredientId: ing(key), packAmount: amount, packUnit: unit, nutritionPer100g: { kcal } });
    products[name] = p;
    await post(`/api/products/${p.id}/prices`, { pricePence: pence, store: 'Greenways' });
  }
  console.log(`Products: ${PRODUCTS.length}, with prices`);

  // Stock.
  const locations = await get('/api/locations');
  const loc = (type) => locations.find((l) => l.type === type).id;
  let packs = 0;
  for (const [name, where, count, days, open] of STOCK) {
    const r = await post('/api/stock', { productId: products[name].id, locationId: loc(where), count, bestBefore: days === null ? null : addDays(today, days) });
    const items = r.items ?? r.created ?? (Array.isArray(r) ? r : [r.item ?? r]);
    packs += count;
    if (open) {
      const first = items[0]?.item ?? items[0];
      if (first?.id) await post(`/api/stock/${first.id}/open`).catch(() => {});
    }
  }
  for (const [name, where, days, fraction] of BINNED) {
    const r = await post('/api/stock', { productId: products[name].id, locationId: loc(where), count: 1, bestBefore: addDays(today, days) });
    const items = r.items ?? r.created ?? (Array.isArray(r) ? r : [r.item ?? r]);
    const first = items[0]?.item ?? items[0];
    await post(`/api/stock/${first.id}/discard`, fraction < 1 ? { amount: { kind: 'fraction', fraction } } : {});
  }
  console.log(`Stock: ${packs} packs added, ${BINNED.length} binned`);

  // Recipes.
  const recipes = {};
  for (const [title, serves, prep, cook, tags, lines, steps] of RECIPES) {
    const r = await post('/api/recipes', {
      title,
      serves,
      prepMinutes: prep,
      cookMinutes: cook,
      tags,
      steps,
      ingredients: lines.map(([text, grams, key]) => ({ text, amount: grams, unit: key === 'milk' || key === 'olive_oil' ? 'ml' : 'g', ingredientId: ing(key) })),
    });
    recipes[title] = r;
  }
  console.log(`Recipes: ${RECIPES.length}`);

  // A batch cook: cottage pie, two portions in the fridge and four in the freezer.
  const pie = recipes['Cottage pie'];
  const plan = await get(`/api/recipes/${pie.id}/cook-plan?servings=6`);
  await post(`/api/recipes/${pie.id}/cook`, {
    servings: 6,
    lines: plan.lines.map((l) => ({ takes: l.takes.map((t) => ({ stockItemId: t.stockItemId, grams: t.grams })) })),
    leftovers: [
      { locationId: loc('fridge'), portions: 2 },
      { locationId: loc('freezer'), portions: 4 },
    ],
  });
  console.log('Batch cook: cottage pie, 2 portions in the fridge and 4 in the freezer');

  // Two weeks of meals already eaten (as notes with calories, so they don't touch today's stock).
  const kcal = (title) => (recipes[title]?.kcalPerServing ?? 600);
  const dinners = ['Chicken & spinach curry', 'Beef chilli', 'Pasta bake', 'Salmon traybake', 'Red lentil dahl', 'Sausage & mash', 'Prawn pesto pasta'];
  const lunches = [['Tuna & chickpea salad', 420], ['Cheese & tomato toastie', 480], ['Leftover chilli', 560], ['Soup and bread', 390]];
  // Household meals: one portion each, so everyone gets their own calories.
  const each = people.map((p) => ({ userId: p.id, portions: 1 }));
  let eaten = 0;
  for (let d = 14; d >= 1; d--) {
    const date = addDays(today, -d);
    const dinner = dinners[d % dinners.length];
    await post('/api/plan', { date, slot: 'dinner', kind: 'text', text: dinner, kcalPerServing: kcal(dinner) + (d % 3) * 40, servings: 3, people: each, eaten: true });
    await post('/api/plan', { date, slot: 'breakfast', kind: 'text', text: d % 7 === 0 ? 'Full English' : 'Porridge with banana', kcalPerServing: d % 7 === 0 ? 780 : 360, servings: 3, people: each, eaten: true });
    const [lunch, lk] = lunches[d % lunches.length];
    await post('/api/plan', { date, slot: 'lunch', kind: 'text', text: lunch, kcalPerServing: lk, servings: 3, people: each, eaten: true });
    if (d % 2 === 0) await post('/api/plan', { date, slot: 'snack', kind: 'text', text: d % 4 === 0 ? 'Ice cream' : 'Greek yogurt', kcalPerServing: d % 4 === 0 ? 270 : 130, people: [{ userId: people[d % 3].id, portions: 1 }], eaten: true });
    eaten += 3;
  }
  await post('/api/plan', { date: today, slot: 'breakfast', kind: 'text', text: 'Porridge with banana', kcalPerServing: 360, servings: 3, people: each, eaten: true });
  console.log(`Meals eaten: ${eaten + 1} over the last two weeks`);

  // The week ahead.
  const ahead = [
    [0, 'dinner', 'Chicken & spinach curry', 3],
    [1, 'dinner', 'Beef chilli', 3],
    [1, 'lunch', 'Tuna & chickpea salad', 2],
    [2, 'dinner', 'Salmon traybake', 2],
    [2, 'lunch', 'Cheese & tomato toastie', 1],
    [3, 'dinner', 'Red lentil dahl', 3],
    [4, 'dinner', 'Sausage & mash', 3],
    [5, 'breakfast', 'Full English', 2],
    [5, 'dinner', 'Pasta bake', 3],
    [7, 'dinner', 'Prawn pesto pasta', 2],
  ];
  for (const [d, slot, title, servings] of ahead) {
    await post('/api/plan', { date: addDays(today, d), slot, kind: 'recipe', recipeId: recipes[title].id, servings, people: servings === 2 ? [{ userId: people[0].id, portions: 1 }, { userId: people[1].id, portions: 1 }] : [] });
  }
  const meals = (await get('/api/stock')).filter((s) => s.isMeal && s.locationType === 'fridge');
  if (meals[0]) await post('/api/plan', { date: addDays(today, 6), slot: 'dinner', kind: 'stock', stockItemId: meals[0].id, servings: 2 });
  console.log(`Planned: ${ahead.length + (meals[0] ? 1 : 0)} meals over the next week`);

  // Shopping list: from the plan, plus a few things typed in, one already ticked.
  await post('/api/shopping/build', { from: today, to: addDays(today, 6) });
  for (const text of ['Birthday candles', 'Washing-up liquid', 'Kitchen roll']) await post('/api/shopping', { text });
  await post('/api/shopping', { ingredientId: ing('lemons'), packs: 2 });
  const list = await get('/api/shopping');
  const candles = list.find((i) => i.text === 'Birthday candles');
  if (candles) await patch(`/api/shopping/${candles.id}`, { checked: true });
  console.log(`Shopping list: ${list.length} things`);

  // A receipt from last week, checked and added (spending and prices), and one waiting to be checked.
  const r1 = await post('/api/receipts/text', { text: RECEIPT(addDays(today, -9)) });
  await post(`/api/receipts/${r1.id}/confirm`);
  await post('/api/receipts/text', { text: RECEIPT(addDays(today, -1)) });
  console.log('Receipts: one added to stock, one ready to check');

  console.log(`Done. Open ${BASE} to look around. Sam and Jo can sign in with the password "demo password 123".`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
