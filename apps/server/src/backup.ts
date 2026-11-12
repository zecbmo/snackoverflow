/**
 * Database backups with pg_dump (custom format, compressed) into BACKUP_DIR.
 * Runs nightly from the scheduler and on demand from Settings. Old backups are
 * pruned after BACKUP_KEEP_DAYS. Restore with pg_restore (see README).
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { BackupDto } from '@snackoverflow/shared';
import type { Config } from './config';

const NAME = /^snackoverflow-\d{8}-\d{6}\.dump$/;

export function backupsEnabled(config: Config): boolean {
  return Boolean(config.BACKUP_DIR);
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export async function listBackups(config: Config): Promise<BackupDto[]> {
  if (!config.BACKUP_DIR) return [];
  let files: string[];
  try {
    files = await readdir(config.BACKUP_DIR);
  } catch {
    return [];
  }
  const out: BackupDto[] = [];
  for (const f of files.filter((f) => NAME.test(f))) {
    const s = await stat(join(config.BACKUP_DIR, f));
    out.push({ name: f, sizeBytes: s.size, createdAt: s.mtime.toISOString() });
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

export async function runBackup(config: Config, now = new Date()): Promise<BackupDto> {
  if (!config.BACKUP_DIR) throw new Error('Backups are not configured (set BACKUP_DIR).');
  await mkdir(config.BACKUP_DIR, { recursive: true });
  const name = `snackoverflow-${stamp(now)}.dump`;
  const file = join(config.BACKUP_DIR, name);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--file', file, '--dbname', config.DATABASE_URL], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', (e) => reject(new Error(`pg_dump could not start: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump failed: ${err.trim()}`))));
  });
  await pruneBackups(config, now);
  const s = await stat(file);
  return { name, sizeBytes: s.size, createdAt: s.mtime.toISOString() };
}

export async function pruneBackups(config: Config, now = new Date()): Promise<void> {
  const cutoff = now.getTime() - config.BACKUP_KEEP_DAYS * 86_400_000;
  for (const b of await listBackups(config)) {
    if (new Date(b.createdAt).getTime() < cutoff && config.BACKUP_DIR) await unlink(join(config.BACKUP_DIR, b.name));
  }
}

export function openBackup(config: Config, name: string) {
  const safe = basename(name);
  if (!config.BACKUP_DIR || !NAME.test(safe)) return null;
  return createReadStream(join(config.BACKUP_DIR, safe));
}
