/** Settings → AI and assistants: the AI key and model, and the MCP token. Admins only. */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { aiKeyTestInput, aiSettingsInput, type AssistantSettingsDto } from '@snackoverflow/shared';
import { requireAdmin } from '../auth/session';
import { badRequest, conflict, parse } from '../http';
import { DEFAULT_AI_MODEL, testAiKey } from '../services/ai';
import { theHousehold } from '../services/household';
import { hint, secretSource, setSecret } from '../services/secrets';

export async function assistantRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  const dto = (): AssistantSettingsDto => ({
    ai: {
      source: secretSource(ctx, 'AI_API_KEY'),
      keyHint: hint(ctx.config.AI_API_KEY),
      model: ctx.config.AI_MODEL ?? DEFAULT_AI_MODEL,
      modelSource: secretSource(ctx, 'AI_MODEL'),
      defaultModel: DEFAULT_AI_MODEL,
    },
    mcp: { source: secretSource(ctx, 'MCP_TOKEN'), tokenHint: hint(ctx.config.MCP_TOKEN), url: `${ctx.config.APP_URL.replace(/\/$/, '')}/mcp` },
  });

  /** Everyone's session sees features turn on and off. */
  const changed = async () => {
    const h = await theHousehold(ctx.db);
    if (h) ctx.live.publish(h.id, 'household');
  };

  app.get('/api/settings/assistants', async (req) => {
    requireAdmin(req);
    return dto();
  });

  /** Save the key and/or model. A key is checked before it's saved. */
  app.put('/api/settings/ai', async (req) => {
    requireAdmin(req);
    const input = parse(aiSettingsInput, req.body);
    if (input.apiKey !== undefined && ctx.envSecrets?.AI_API_KEY) throw conflict('The AI key is set by the server (AI_API_KEY), so it can only be changed there.');
    if (input.model !== undefined && ctx.envSecrets?.AI_MODEL) throw conflict('The AI model is set by the server (AI_MODEL), so it can only be changed there.');
    const model = (input.model === undefined ? ctx.config.AI_MODEL : input.model) || DEFAULT_AI_MODEL;
    if (input.apiKey) await testAiKey(input.apiKey, model, ctx.fetch);
    else if (input.model && ctx.config.AI_API_KEY) await testAiKey(ctx.config.AI_API_KEY, model, ctx.fetch);
    if (input.apiKey !== undefined) await setSecret(ctx, 'AI_API_KEY', input.apiKey ?? null);
    if (input.model !== undefined) await setSecret(ctx, 'AI_MODEL', input.model && input.model !== DEFAULT_AI_MODEL ? input.model : null);
    await changed();
    return dto();
  });

  /** Check a key (the one given, or the one in use) without saving anything. */
  app.post('/api/settings/ai/test', async (req) => {
    requireAdmin(req);
    const input = parse(aiKeyTestInput, req.body);
    const key = input.apiKey ?? ctx.config.AI_API_KEY;
    if (!key) throw badRequest('There is no AI key to check.');
    const model = input.model || ctx.config.AI_MODEL || DEFAULT_AI_MODEL;
    await testAiKey(key, model, ctx.fetch);
    return { ok: true, model };
  });

  /** A new MCP token, shown once. Any assistant using the old one has to be given the new one. */
  app.post('/api/settings/mcp-token', async (req) => {
    requireAdmin(req);
    if (ctx.envSecrets?.MCP_TOKEN) throw conflict('The MCP token is set by the server (MCP_TOKEN), so it can only be changed there.');
    const token = randomBytes(24).toString('base64url');
    await setSecret(ctx, 'MCP_TOKEN', token);
    await changed();
    return { token, settings: dto() };
  });

  app.delete('/api/settings/mcp-token', async (req) => {
    requireAdmin(req);
    if (ctx.envSecrets?.MCP_TOKEN) throw conflict('The MCP token is set by the server (MCP_TOKEN), so it can only be changed there.');
    await setSecret(ctx, 'MCP_TOKEN', null);
    await changed();
    return dto();
  });
}
