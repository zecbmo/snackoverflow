/**
 * Server for the Playwright tests: the real app on an in-memory PGlite database,
 * with a fake Open Food Facts, serving the built web app. No Docker needed.
 */
import { fileURLToPath } from 'node:url';
import { webDistDir } from '../src/paths';
import { loadChainSeed, syncChains } from '../src/services/chains';
import { FakeOff, makeTestApp } from './helpers';

const port = Number(process.env.E2E_PORT ?? 3210);
const off = new FakeOff({
  '5000000000017': { name: 'Semi Skimmed Milk', brand: 'Dairy Co', quantity: '2.27 l' },
  '5000000000024': { name: 'Chicken Thighs', quantity: '1 kg' },
  '5000000000031': { name: 'Baked Beans', quantity: '415 g' },
  '5000000000048': { name: 'Beef Mince', quantity: '500 g' },
  '5000000000055': { name: 'Penne Pasta', quantity: '500 g' },
  '5000000000062': { name: 'Salmon Fillets', quantity: '240 g' },
  '5000000000079': { name: 'Greek Yogurt', quantity: '500 g' },
  '5000000000086': { name: 'Houmous', quantity: '200 g' },
});
/**
 * A pretend Claude for the AI features, so their flows can be tested end to end. It answers by
 * which job the request is for; everything else goes out as normal.
 */
const message = (answer: unknown) =>
  new Response(
    JSON.stringify({
      id: 'msg_e2e',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: JSON.stringify(answer) }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const fakeClaude = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://api.anthropic.com/')) return fetch(input, init);
  if (url.includes('/v1/models/')) return new Response(JSON.stringify({ id: 'claude-opus-5-5', type: 'model', display_name: 'Claude', created_at: '2026-01-01T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
  const system = String((JSON.parse(String(init?.body ?? '{}')) as { system?: string }).system ?? '');
  if (system.includes("food product's packaging")) {
    return message({
      readable: true,
      name: 'Oat Drink',
      brand: 'Oaty',
      packAmount: 1,
      packUnit: 'l',
      ingredientId: null,
      nutritionPer100g: { kcal: 46, protein: 1, carbs: 6.7, sugars: 4, fat: 1.5, saturates: 0.2, fibre: 0.8, salt: 0.1 },
    });
  }
  if (system.includes('photos of a recipe')) {
    return message({
      readable: true,
      title: 'Tomato pasta from a card',
      serves: 2,
      prepMinutes: 5,
      cookMinutes: 15,
      steps: ['Boil the pasta.', 'Stir in the sauce.'],
      tags: ['dinner'],
      ingredients: [
        { text: '200g penne pasta', amount: 200, unit: 'g', ingredientId: null, note: null, optional: false },
        { text: '1 tin chopped tomatoes', amount: 1, unit: 'count', ingredientId: null, note: null, optional: false },
      ],
    });
  }
  if (system.includes('plan meals')) return message({ picks: [] });
  if (system.includes('fix recipe ingredient lines')) return message({ suggestions: [] });
  return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'not faked' } }), { status: 500, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const t = await makeTestApp({ off, webDist: webDistDir(), realClock: true, fetch: fakeClaude, config: {
    // A pretend AI key: the fake above answers instead of the real service.
    AI_API_KEY: 'sk-ant-e2e-fake-key-0000000000',
    APP_URL: `http://localhost:${port}`,
    // A pretend Open Food Facts account, so "Add it to Open Food Facts" shows (the fake records what's added).
    OFF_CONTRIBUTE_USER_ID: 'e2e',
    OFF_CONTRIBUTE_PASSWORD: 'e2e',
  },
});
// A small made-up set of chains, so the Fast food & takeaways page has something stable to show.
await syncChains(t.ctx.db, loadChainSeed(fileURLToPath(new URL('./fixtures/chains', import.meta.url))).chains);
await t.app.listen({ port, host: '127.0.0.1' });
console.log(`e2e server on http://localhost:${port}`);
