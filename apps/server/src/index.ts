import { buildApp } from './app';
import { loadConfig } from './config';
import type { AppContext } from './context';
import { connect } from './db/client';
import { loadSeedData, syncSeedData } from './db/seed';
import { LiveHub } from './live';
import { createMailer } from './notify/email';
import { createPushSender } from './notify/push';
import { migrationsDir, seedDataDir, webDistDir } from './paths';
import { startScheduler } from './scheduler';
import { ensureFirstAdmin } from './services/household';
import { createOff } from './services/off';

async function main() {
  const config = loadConfig();
  const { db, close } = await connect(config.DATABASE_URL, migrationsDir());
  const ctx: AppContext = {
    db,
    config,
    seed: loadSeedData(seedDataDir(config.SEED_DATA_DIR)),
    live: new LiveHub(),
    off: createOff({ baseUrl: config.OFF_BASE_URL, userAgent: config.OFF_USER_AGENT }),
    mailer: createMailer(config),
    push: createPushSender(config),
    now: () => new Date(),
    fetch: globalThis.fetch,
  };
  const app = await buildApp(ctx, {
    logger: { level: config.isProduction ? 'info' : 'debug' },
    webDist: webDistDir(config.WEB_DIST_DIR),
  });

  await syncSeedData(ctx.db, ctx.seed);
  const admin = await ensureFirstAdmin(ctx);
  if (admin) app.log.info({ email: admin.email }, 'created the first admin from ADMIN_EMAIL');

  const stopScheduler = config.SCHEDULER_ENABLED ? startScheduler(ctx, app.log) : () => {};
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  const shutdown = async () => {
    stopScheduler();
    await app.close();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
