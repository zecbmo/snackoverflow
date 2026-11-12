/** Apply database migrations and exit. The server also does this on start. */
import { loadConfig } from './config';
import { connect } from './db/client';
import { migrationsDir } from './paths';

const config = loadConfig();
const { close } = await connect(config.DATABASE_URL, migrationsDir());
await close();
console.log('Migrations applied.');
