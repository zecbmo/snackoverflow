import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecipeDraftDto } from '@snackoverflow/shared';
import { loadCatalog } from '../src/services/catalog';
import { cleanText, parseRecipePage, readServes, readSteps } from '../src/services/recipeImport';
import { type Client, makeTestApp, setupAdmin, type TestApp } from './helpers';

/** BBC Good Food style: the Recipe sits inside an @graph with other entities. */
const GRAPH_PAGE = `<!doctype html><html><head><title>Fish pie</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Food site"}</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"Organization","name":"Food site"},
  {"@type":["Recipe"],"name":"Easy fish pie &amp; peas","recipeYield":"Serves 4",
   "image":{"@type":"ImageObject","url":"https://images.example/fish-pie.jpg"},
   "prepTime":"PT20M","cookTime":"PT1H",
   "keywords":"fish pie, Comfort Food, family","recipeCategory":"Dinner","recipeCuisine":"British",
   "recipeIngredient":["1kg potatoes, peeled and chopped","50g butter","400g mixed fish fillets","2 tbsp plain flour","500ml milk"],
   "recipeInstructions":[{"@type":"HowToStep","text":"Boil the potatoes until tender.<br>Drain."},{"@type":"HowToStep","text":"Make the sauce &amp; add the fish."}]}
]}
</script></head><body>...</body></html>`;

/** A plain Recipe object with HowToSection instructions and an array yield. */
const SECTION_PAGE = `<html><head><script type='application/ld+json'>
[{"@context":"https://schema.org/","@type":"Recipe","name":"Chicken traybake",
  "recipeYield":["2","2 servings"],"image":["https://img.example/a.jpg","https://img.example/b.jpg"],
  "recipeIngredient":["4 chicken thighs","2 red peppers, sliced","1 tbsp olive oil"],
  "recipeInstructions":[
    {"@type":"HowToSection","name":"Prep","itemListElement":[{"@type":"HowToStep","text":"Heat the oven to 200C."},{"@type":"HowToStep","text":"Slice the peppers."}]},
    {"@type":"HowToSection","name":"Cook","itemListElement":[{"@type":"HowToStep","text":"Roast for 40 minutes."}]}
  ]}]
</script></head></html>`;

/** Instructions as one string with numbered lines. */
const STRING_PAGE = `<script type="application/ld+json">{"@type":"Recipe","name":"Beans on toast","recipeYield":1,
"recipeIngredient":["1 tin baked beans","2 slices bread"],"recipeInstructions":"1. Heat the beans.\\n2. Toast the bread.\\n3. Combine."}</script>`;

let t: TestApp;
let api: Client;
const pages: Record<string, string> = {
  'https://food.example/fish-pie': GRAPH_PAGE,
  'https://food.example/traybake': SECTION_PAGE,
  'https://food.example/nothing': '<html><body>No recipe here</body></html>',
};
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const page = pages[url];
  if (page === undefined) return new Response('Not found', { status: 404 });
  return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
}) as typeof fetch;

beforeEach(async () => {
  t = await makeTestApp({ fetch: fakeFetch });
  api = await setupAdmin(t.app);
});
afterEach(async () => {
  await t.close();
});

async function catalog() {
  const s = await api.get<{ household: { id: string } }>('/api/session');
  return loadCatalog(t.ctx.db, s.household.id);
}

describe('recipe page parsing', () => {
  it('finds a Recipe inside @graph and maps every field', async () => {
    const d = parseRecipePage(GRAPH_PAGE, 'https://food.example/fish-pie', await catalog(), t.ctx.seed)!;
    expect(d).toMatchObject({
      title: 'Easy fish pie & peas',
      serves: 4,
      imageUrl: 'https://images.example/fish-pie.jpg',
      sourceUrl: 'https://food.example/fish-pie',
      prepMinutes: 20,
      cookMinutes: 60,
      steps: ['Boil the potatoes until tender.\nDrain.', 'Make the sauce & add the fish.'],
      tags: ['fish pie', 'comfort food', 'family', 'dinner', 'british'],
    });
    expect(d.ingredients[0]).toMatchObject({ text: '1kg potatoes, peeled and chopped', amount: 1, unit: 'kg', ingredientName: 'Potatoes', note: 'peeled and chopped' });
    expect(d.ingredients[4]).toMatchObject({ amount: 500, unit: 'ml', ingredientName: 'Milk' });
  });

  it('flattens HowToSection steps and reads array yields and images', async () => {
    const d = parseRecipePage(SECTION_PAGE, null, await catalog(), t.ctx.seed)!;
    expect(d.serves).toBe(2);
    expect(d.imageUrl).toBe('https://img.example/a.jpg');
    expect(d.steps).toEqual(['Heat the oven to 200C.', 'Slice the peppers.', 'Roast for 40 minutes.']);
    expect(d.ingredients.map((i) => i.ingredientName)).toEqual(['Chicken thighs', 'Red peppers', 'Olive oil']);
  });

  it('splits string instructions and drops step numbers', async () => {
    const d = parseRecipePage(STRING_PAGE, null, await catalog(), t.ctx.seed)!;
    expect(d.serves).toBe(1);
    expect(d.steps).toEqual(['Heat the beans.', 'Toast the bread.', 'Combine.']);
  });

  it('returns null when there is no recipe', async () => {
    expect(parseRecipePage('<html></html>', null, await catalog(), t.ctx.seed)).toBeNull();
  });

  it('reads yields and cleans text', () => {
    expect(readServes('Makes 12 cookies')).toBe(12);
    expect(readServes(['4', '4 servings'])).toBe(4);
    expect(readServes(undefined)).toBe(4);
    expect(readSteps({ '@type': 'HowToStep', name: 'Mix' })).toEqual(['Mix']);
    expect(cleanText('Fry &frac12; the onion &#8211; gently')).toBe('Fry ½ the onion – gently');
  });
});

describe('POST /api/recipes/import', () => {
  it('imports a page into a draft without saving it', async () => {
    const d = await api.post<RecipeDraftDto>('/api/recipes/import', { url: 'https://food.example/fish-pie' });
    expect(d.title).toBe('Easy fish pie & peas');
    expect(d.ingredients).toHaveLength(5);
    expect(await api.get('/api/recipes')).toEqual([]);
  });

  it('explains when there is no recipe on the page', async () => {
    const r = await api.raw('POST', '/api/recipes/import', { url: 'https://food.example/nothing' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Couldn't find a recipe on that page/);
  });

  it('explains when the page does not load', async () => {
    const r = await api.raw('POST', '/api/recipes/import', { url: 'https://food.example/missing' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/error 404/);
  });

  it('only accepts web links', async () => {
    expect((await api.raw('POST', '/api/recipes/import', { url: 'ftp://food.example/x' })).statusCode).toBe(400);
    expect((await api.raw('POST', '/api/recipes/import', { url: 'not a url' })).statusCode).toBe(400);
  });
});
