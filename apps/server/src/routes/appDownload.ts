/** The Android app as a download from this server: /apk, when APK_PATH points at an APK file. */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { AppDownloadDto } from '@snackoverflow/shared';
import { requireAuth } from '../auth/session';

export async function appDownloadRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /** The APK on disk, or null when the setting is empty or nothing is there (yet). Looked up each time: the file is replaced by hand. */
  const apk = async () => {
    const path = ctx.config.APK_PATH;
    if (!path) return null;
    const s = await stat(path).catch(() => null);
    return s?.isFile() && s.size > 0 ? { path, bytes: s.size, updatedAt: s.mtime } : null;
  };

  /** For Settings: is there an app to download, how big and how new. */
  app.get('/api/app-download', async (req): Promise<AppDownloadDto> => {
    requireAuth(req);
    const file = await apk();
    return file ? { available: true, bytes: file.bytes, updatedAt: file.updatedAt.toISOString() } : { available: false, bytes: null, updatedAt: null };
  });

  /**
   * The file itself. Open without signing in: a new phone has no session yet, the app is the
   * same public build for everyone, and it holds nothing of the household's.
   */
  app.get('/apk', async (_req, reply) => {
    const file = await apk();
    if (!file) return reply.status(404).type('text/plain; charset=utf-8').send("The Android app isn't available to download from this server.");
    return reply
      .header('Content-Type', 'application/vnd.android.package-archive')
      .header('Content-Disposition', 'attachment; filename="snackoverflow.apk"')
      .header('Content-Length', file.bytes)
      .header('Last-Modified', file.updatedAt.toUTCString())
      .header('Cache-Control', 'no-cache')
      .send(createReadStream(file.path));
  });
}
