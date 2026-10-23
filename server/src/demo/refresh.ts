/**
 * Docs: /docs/features/demo-data.md
 * Keeps the demo restaurant looking like a service in progress. Reviewers open the URL hours or
 * days after deploy; timers saying "113 minutes" or a history that stops last week would read as broken.
 * Only runs when DEMO_MODE=true. Never enabled for a real restaurant: it truncates every table.
 */
import pg from 'pg';
import type { Config } from '../config.js';
import { seed } from '../seed/seed.js';

const STALE_AFTER_HOURS = 6;
const CHECK_EVERY_MS = 15 * 60_000;

export function startDemoRefresh(config: Config, log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }) {
  if (config.DEMO_MODE !== 'true') return () => undefined;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    const c = new pg.Client({ connectionString: config.DATABASE_ADMIN_URL });
    try {
      await c.connect();
      const r = await c.query(`SELECT coalesce(extract(epoch FROM now() - max(opened_at)) / 3600, 9999) AS age_h FROM orders`).catch(() => ({ rows: [{ age_h: 9999 }] }));
      await c.end();
      if (Number(r.rows[0].age_h) >= STALE_AFTER_HOURS) {
        log.info({ ageHours: Number(r.rows[0].age_h) }, 'demo data is stale, re-seeding');
        await seed(config.DATABASE_ADMIN_URL, config.APP_DB_PASSWORD, { reset: true });
        log.info({}, 'demo data refreshed');
      }
    } catch (err) {
      log.error({ err }, 'demo refresh failed');
      await c.end().catch(() => undefined);
    } finally {
      running = false;
    }
  };
  void tick();
  const t = setInterval(() => void tick(), CHECK_EVERY_MS);
  return () => clearInterval(t);
}
