import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadAuth } from './auth/session';
import type { AppContext } from './context';
import { HttpError } from './http';
import { authRoutes } from './routes/auth';
import { catalogRoutes } from './routes/catalog';
import { inboxRoutes } from './routes/inbox';
import { mcpRoutes } from './routes/mcp';
import { recipeImportRoutes } from './routes/recipeImport';
import { recipeRoutes } from './routes/recipes';
import { peopleRoutes } from './routes/people';
import { stockRoutes } from './routes/stock';

export interface BuildOptions {
  logger?: boolean | object;
  webDist?: string | null;
}

export async function buildApp(ctx: AppContext, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  app.decorate('ctx', ctx);
  app.decorateRequest('auth', null);

  await app.register(cookie, { secret: ctx.config.SESSION_SECRET });
  await app.register(websocket);

  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/')) req.auth = await loadAuth(ctx, req);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: (err as Error).message });
    }
    req.log.error({ err }, 'request failed');
    return reply.status(500).send({ error: 'Something went wrong. Please try again.' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/live', { websocket: true }, (socket, req) => {
    if (!req.auth) {
      socket.close(4401, 'Please sign in.');
      return;
    }
    const remove = ctx.live.add(req.auth.household.id, socket);
    socket.on('close', remove);
    // Keep proxies from closing idle connections.
    const ping = setInterval(() => socket.readyState === 1 && socket.ping(), 30_000);
    socket.on('close', () => clearInterval(ping));
  });

  await app.register(authRoutes);
  await app.register(peopleRoutes);
  await app.register(catalogRoutes);
  await app.register(stockRoutes);
  await app.register(inboxRoutes);
  await app.register(recipeRoutes);
  await app.register(recipeImportRoutes);
  await app.register(mcpRoutes);

  const webDist = opts.webDist && existsSync(join(opts.webDist, 'index.html')) ? opts.webDist : null;
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      setHeaders(res, path) {
        // Hashed build assets never change; everything else (index.html, sw.js) is revalidated.
        res.header('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (webDist && req.method === 'GET' && !req.url.startsWith('/api/')) {
      // Client-side routes: serve the app shell.
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: 'Not found.' });
  });
  return app;
}
