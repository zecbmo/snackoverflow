/**
 * Server for the Playwright tests: the real app on an in-memory PGlite database,
 * with a fake Open Food Facts, serving the built web app. No Docker needed.
 */
import { webDistDir } from '../src/paths';
import { FakeOff, makeTestApp } from './helpers';

const port = Number(process.env.E2E_PORT ?? 3210);
const off = new FakeOff({
  '5000000000017': { name: 'Semi Skimmed Milk', brand: 'Dairy Co', quantity: '2.27 l' },
  '5000000000024': { name: 'Chicken Thighs', quantity: '1 kg' },
  '5000000000031': { name: 'Baked Beans', quantity: '415 g' },
});
const t = await makeTestApp({ off, webDist: webDistDir(), realClock: true, config: { APP_URL: `http://localhost:${port}` } });
await t.app.listen({ port, host: '127.0.0.1' });
console.log(`e2e server on http://localhost:${port}`);
