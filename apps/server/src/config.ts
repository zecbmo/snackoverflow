import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));
const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  APP_URL: z.string().default('http://localhost:5173'),
  PORT: z.coerce.number().int().default(3000),
  TZ: z.string().default('Europe/London'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters').default('dev-only-session-secret-change-me'),
  DATABASE_URL: z.string().default('postgres://snackoverflow:snackoverflow@localhost:5432/snackoverflow'),
  ADMIN_EMAIL: optional,
  ADMIN_PASSWORD: optional,
  ADMIN_NAME: optional,
  HOUSEHOLD_NAME: optional,
  OIDC_ISSUER_URL: optional,
  OIDC_CLIENT_ID: optional,
  OIDC_CLIENT_SECRET: optional,
  OIDC_DISPLAY_NAME: z.string().default('Single sign-on'),
  OIDC_ALLOW_PASSWORD_LOGIN: bool(true),
  OFF_USER_AGENT: z.string().default('SnackOverflow/0.1 (self-hosted)'),
  OFF_BASE_URL: z.string().default('https://world.openfoodfacts.org'),
  OFF_ENABLED: bool(true),
  SMTP_HOST: optional,
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: optional,
  SMTP_PASSWORD: optional,
  SMTP_FROM: z.string().default('Snack Overflow <snacks@example.com>'),
  VAPID_PUBLIC_KEY: optional,
  VAPID_PRIVATE_KEY: optional,
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),
  BACKUP_DIR: optional,
  BACKUP_KEEP_DAYS: z.coerce.number().int().min(1).default(14),
  BACKUP_TIME: z.string().regex(/^\d{2}:\d{2}$/).default('03:30'),
  SEED_DATA_DIR: optional,
  WEB_DIST_DIR: optional,
  SCHEDULER_ENABLED: bool(true),
});

export type Config = z.infer<typeof envSchema> & {
  isProduction: boolean;
  secureCookies: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const c = parsed.data;
  const isProduction = c.NODE_ENV === 'production';
  if (isProduction && c.SESSION_SECRET === 'dev-only-session-secret-change-me') {
    throw new Error('Set SESSION_SECRET to a long random string in production.');
  }
  return { ...c, isProduction, secureCookies: c.APP_URL.startsWith('https://') };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ NODE_ENV: 'test', OFF_ENABLED: 'false', SCHEDULER_ENABLED: 'false' }), ...overrides };
}
