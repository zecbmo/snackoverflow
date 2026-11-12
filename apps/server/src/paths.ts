import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Find a directory that ships with the app. Works from the source tree
 * (apps/server/src), the bundled build (apps/server/dist) and the Docker image (/app).
 */
export function findDir(override: string | undefined, relativeToRepoRoot: string, relativeToApp: string): string {
  const candidates = [
    override,
    resolve(process.cwd(), relativeToApp),
    resolve(process.cwd(), relativeToRepoRoot),
    resolve(here, '..', relativeToApp),
    resolve(here, '../..', relativeToApp),
    resolve(here, '../../..', relativeToRepoRoot),
    resolve(here, '../../../..', relativeToRepoRoot),
  ].filter((c): c is string => Boolean(c));
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`Could not find ${relativeToRepoRoot}; looked in:\n${candidates.join('\n')}`);
  return found;
}

export const seedDataDir = (override?: string) => findDir(override, 'docs/data', 'docs/data');
export const migrationsDir = (override?: string) => findDir(override, 'apps/server/drizzle', 'drizzle');
export const webDistDir = (override?: string) => {
  try {
    return findDir(override, 'apps/web/dist', 'public');
  } catch {
    return null;
  }
};
