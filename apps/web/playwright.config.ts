import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3210);

// Set PW_CHANNEL=chrome to use an installed Chrome instead of downloading Playwright's Chromium.
const channel = process.env.PW_CHANNEL;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], ...(channel ? { channel } : {}) } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, ...(channel ? { channel } : {}) } },
  ],
  webServer: {
    // The real server on an in-memory database, serving the built web app (run `pnpm build` first).
    command: 'pnpm --filter @snackoverflow/server exec tsx test/e2e-server.ts',
    url: `http://localhost:${port}/api/health`,
    env: { E2E_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
