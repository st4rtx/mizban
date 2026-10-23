import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildApp } from './app.js';
import { startDemoRefresh } from './demo/refresh.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const app = await buildApp({ config, db });

const shutdown = async (sig: string) => {
  app.log.info({ sig }, 'shutting down');
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandledRejection'));

await app.listen({ host: '0.0.0.0', port: config.PORT });
startDemoRefresh(config, app.log);
