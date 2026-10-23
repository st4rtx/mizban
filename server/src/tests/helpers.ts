import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { seed } from '../seed/seed.js';

const ADMIN = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://mizban:dev-admin-pw@127.0.0.1:5455/postgres';
// Roles are cluster-wide, so tests must use the same app-role password as the dev database or they would lock the dev API out.
const APP_PW = process.env.APP_DB_PASSWORD ?? 'dev-app-pw';
const dbUrl = (user: string, pw: string) => ADMIN.replace(/\/\/[^@]+@/, `//${user}:${pw}@`).replace(/\/[^/]*$/, '/mizban_test');

/** Fresh database per test file: real migrations, real seed, real Postgres. No mocks for the thing we are proving. */
export async function setup() {
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  await root.query('DROP DATABASE IF EXISTS mizban_test WITH (FORCE)');
  await root.query('CREATE DATABASE mizban_test');
  await root.end();
  const adminUrl = dbUrl(new URL(ADMIN).username, decodeURIComponent(new URL(ADMIN).password));
  await seed(adminUrl, APP_PW);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: dbUrl('mizban_app', APP_PW),
    DATABASE_ADMIN_URL: adminUrl,
    APP_DB_PASSWORD: APP_PW,
    SESSION_SECRET: 'x'.repeat(40),
    LOG_LEVEL: 'silent',
    WEB_DIST: '/nonexistent',
  } as NodeJS.ProcessEnv);
  const db = createPool(config.DATABASE_URL, 20);
  const app = await buildApp({ config, db });
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  return {
    app,
    db,
    admin,
    config,
    async close() {
      await app.close();
      await db.end();
      await admin.end();
    },
  };
}

export type Ctx = Awaited<ReturnType<typeof setup>>;

export async function login(ctx: Ctx, username: string, password = 'demo1234') {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${username}: ${res.statusCode}`);
  const cookie = res.cookies.find((c) => c.name === 'mz_session')!;
  return { cookie: `mz_session=${cookie.value}` };
}

export function api(ctx: Ctx, session: { cookie: string }) {
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => {
    const res = await ctx.app.inject({ method, url, payload: payload as object, headers: { cookie: session.cookie } });
    return { status: res.statusCode, body: res.json() as any };
  };
  return {
    get: (u: string) => call('GET', u),
    post: (u: string, b?: unknown) => call('POST', u, b ?? {}),
    put: (u: string, b?: unknown) => call('PUT', u, b),
    patch: (u: string, b?: unknown) => call('PATCH', u, b),
  };
}

export const uuid = () => randomUUID();

/** Convenient lookups straight from the admin connection (bypasses RLS on purpose; this is test setup). */
export async function fixtures(ctx: Ctx) {
  const q = async (sql: string, p: unknown[] = []) => (await ctx.admin.query(sql, p)).rows;
  const [saadat] = await q(`SELECT b.id, b.restaurant_id FROM branches b WHERE b.name = 'نارنج سعادت‌آباد'`);
  const [bagh] = await q(`SELECT b.id, b.restaurant_id FROM branches b WHERE b.name = 'چای‌خانه باغ'`);
  const freeTable = async (branchId: string) =>
    (await q(`SELECT id FROM dining_tables t WHERE branch_id = $1 AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id = t.id AND o.status = 'open') ORDER BY sort LIMIT 1`, [branchId]))[0].id as string;
  const menuItem = async (restaurantId: string, name: string) =>
    (await q(`SELECT id, price FROM menu_items WHERE restaurant_id = $1 AND name = $2`, [restaurantId, name]))[0] as { id: string; price: number };
  return { saadat, bagh, freeTable, menuItem, q };
}
