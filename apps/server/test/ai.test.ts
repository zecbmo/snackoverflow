import { afterEach, describe, expect, it } from 'vitest';
import type { FeaturesDto, IngredientDto, RecipeDraftDto, SessionDto } from '@snackoverflow/shared';
import { makeTestApp, setupAdmin, type TestApp } from './helpers';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const draft: RecipeDraftDto = {
  title: 'BEST EVER Fish Pie!!! (Easy)',
  serves: 4,
  steps: ['Jump to recipe', 'Boil potatoes. Then mash them with butter.'],
  imageUrl: null,
  sourceUrl: 'https://food.example/fish-pie',
  tags: [],
  prepMinutes: null,
  cookMinutes: null,
  ingredients: [
    { text: '2 large Maris Pipers, peeled', amount: 2, unit: 'count', ingredientId: null, ingredientName: null, productId: null, note: 'peeled', optional: false, matchConfidence: 'none' },
    { text: '50g butter', amount: 50, unit: 'g', ingredientId: null, ingredientName: null, productId: null, note: null, optional: false, matchConfidence: 'none' },
  ],
};

/** A fake Anthropic Messages API: records requests, answers with the given JSON as the model's text. */
function fakeClaude(answer: (ids: Record<string, string>) => unknown, ids: Record<string, string>, calls: { url: string; body: Record<string, unknown> }[]) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, body });
    return new Response(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: JSON.stringify(answer(ids)) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } },
    );
  }) as typeof fetch;
}

async function setup(fetchFn?: typeof fetch, key: string | null = 'test-key') {
  t = await makeTestApp({ fetch: fetchFn, config: { AI_API_KEY: key ?? undefined } });
  const api = await setupAdmin(t.app);
  const ings = await api.get<IngredientDto[]>('/api/ingredients');
  const ids = Object.fromEntries(ings.map((i) => [i.name, i.id]));
  return { api, ids };
}

describe('AI clean-up', () => {
  it('is hidden and refused when no key is set', async () => {
    const { api } = await setup(undefined, null);
    expect((await api.get<SessionDto>('/api/session')).features).toMatchObject<Partial<FeaturesDto>>({ ai: false, mcp: false });
    const r = await api.raw('POST', '/api/recipes/tidy', { draft });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("AI clean-up isn't set up on this server.");
  });

  it('tidies the draft and matches lines, dropping ids that are not ours', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let potatoId = '';
    const fetchFn = fakeClaude(
      () => ({
        title: 'Fish pie',
        serves: 4,
        steps: ['Boil the potatoes.', 'Mash with the butter.'],
        tags: ['Comfort Food', 'fish'],
        ingredients: [
          { text: '2 large Maris Pipers, peeled', amount: 2, unit: 'count', ingredientId: potatoId, note: 'peeled', optional: false },
          { text: '50g butter', amount: 50, unit: 'g', ingredientId: '00000000-0000-4000-8000-000000000000', note: null, optional: false },
        ],
      }),
      {},
      calls,
    );
    const { api, ids } = await setup(fetchFn);
    potatoId = ids.Potatoes!;
    const out = await api.post<RecipeDraftDto>('/api/recipes/tidy', { draft });
    expect(out.title).toBe('Fish pie');
    expect(out.steps).toEqual(['Boil the potatoes.', 'Mash with the butter.']);
    expect(out.tags).toEqual(['comfort food', 'fish']);
    expect(out.ingredients[0]).toMatchObject({ ingredientId: ids.Potatoes, ingredientName: 'Potatoes', matchConfidence: 'high' });
    // An id the model made up is dropped.
    expect(out.ingredients[1]).toMatchObject({ ingredientId: null, matchConfidence: 'none', amount: 50, unit: 'g' });
    expect(out.sourceUrl).toBe(draft.sourceUrl);

    // The request uses the configured model, structured output and the household's ingredient list.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/v1/messages');
    expect(calls[0]!.body.model).toBe('claude-opus-5-5');
    expect(JSON.stringify(calls[0]!.body.messages)).toContain(ids.Potatoes!);
    expect((calls[0]!.body.output_config as { format?: { type?: string } }).format?.type).toBe('json_schema');
  });

  it('keeps the original lines when the model returns a different number of them', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = fakeClaude(() => ({ title: 'Fish pie', serves: 4, steps: ['Cook.'], tags: [], ingredients: [] }), {}, calls);
    const { api } = await setup(fetchFn);
    const out = await api.post<RecipeDraftDto>('/api/recipes/tidy', { draft });
    expect(out.ingredients).toEqual(draft.ingredients);
  });

  it('fails gracefully when the AI service is down', async () => {
    const fetchFn = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const { api } = await setup(fetchFn);
    const r = await api.raw('POST', '/api/recipes/tidy', { draft });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/Couldn't reach the AI service/);
  });

  it('reports a rejected key', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const { api } = await setup(fetchFn);
    const r = await api.raw('POST', '/api/recipes/tidy', { draft });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/AI key was rejected/);
  });
});
