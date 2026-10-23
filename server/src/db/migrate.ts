import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '../../migrations');

export async function migrate(adminUrl: string, appPassword: string, log: (m: string) => void = console.log) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    // Runtime role: owns nothing, bypasses nothing. Password comes from env, never from SQL files.
    await client.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mizban_app') THEN
           CREATE ROLE mizban_app LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
         END IF;
       END $$`,
    );
    await client.query(`SELECT set_config('mizban.pw', $1, false)`, [appPassword]);
    await client.query(`DO $$ BEGIN EXECUTE format('ALTER ROLE mizban_app PASSWORD %L', current_setting('mizban.pw')); END $$`);
    await client.query(`SELECT set_config('mizban.pw', '', false)`);
    await client.query(`DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO mizban_app', current_database()); END $$`);
    await client.query(`GRANT USAGE ON SCHEMA public TO mizban_app`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mizban_app`);
    await client.query(`REVOKE ALL ON schema_migrations FROM mizban_app`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mizban_app`);
    await client.query(`GRANT EXECUTE ON FUNCTION auth_lookup(text) TO mizban_app`);
    // Audit log is append-only for the app role.
    await client.query(`REVOKE UPDATE, DELETE ON audit_log FROM mizban_app`);
    log('migrations up to date');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_ADMIN_URL;
  const pw = process.env.APP_DB_PASSWORD;
  if (!url || !pw) {
    console.error('DATABASE_ADMIN_URL and APP_DB_PASSWORD are required');
    process.exit(1);
  }
  migrate(url, pw).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
