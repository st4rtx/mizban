// Proof that restaurant A can never see restaurant B: at the database (RLS) and at the HTTP layer.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { withTenant } from '../db/pool.js';
import { signSession } from '../lib/session.js';
import { api, fixtures, login, setup, uuid, type Ctx } from './helpers.js';

const TENANT_TABLES = ['branches', 'users', 'dining_tables', 'menu_categories', 'menu_items', 'orders', 'order_items', 'payments', 'audit_log', 'day_briefs', 'restaurants'];

describe('tenant isolation', () => {
  let ctx: Ctx;
  let f: Awaited<ReturnType<typeof fixtures>>;
  before(async () => {
    ctx = await setup();
    f = await fixtures(ctx);
  });
  after(() => ctx.close());

  it('database: with no tenant set, every table returns zero rows (fails closed)', async () => {
    for (const t of TENANT_TABLES) {
      const r = await ctx.db.query(`SELECT count(*)::int AS n FROM ${t}`);
      assert.equal(r.rows[0].n, 0, `${t} leaked rows without a tenant`);
    }
  });

  it('database: tenant A sees only its own rows in every table', async () => {
    for (const t of TENANT_TABLES) {
      const key = t === 'restaurants' ? 'id' : 'restaurant_id';
      const rows = await withTenant(ctx.db, f.bagh.restaurant_id, async (tx) => (await tx.query(`SELECT DISTINCT ${key} AS k FROM ${t}`)).rows);
      assert.ok(rows.every((r) => r.k === f.bagh.restaurant_id), `${t} returned another tenant's rows`);
    }
  });

  it('database: tenant A cannot read, update or insert into tenant B', async () => {
    const [{ id: orderOfNarenj }] = await f.q(`SELECT id FROM orders WHERE restaurant_id = $1 LIMIT 1`, [f.saadat.restaurant_id]);
    await withTenant(ctx.db, f.bagh.restaurant_id, async (tx) => {
      assert.equal((await tx.query('SELECT 1 FROM orders WHERE id = $1', [orderOfNarenj])).rowCount, 0);
      assert.equal((await tx.query(`UPDATE orders SET guests = 99 WHERE id = $1`, [orderOfNarenj])).rowCount, 0);
    });
    await assert.rejects(
      withTenant(ctx.db, f.bagh.restaurant_id, (tx) =>
        tx.query(`INSERT INTO menu_categories (restaurant_id, name) VALUES ($1, 'planted')`, [f.saadat.restaurant_id]),
      ),
      /row-level security/,
    );
    const [{ guests }] = await f.q('SELECT guests FROM orders WHERE id = $1', [orderOfNarenj]);
    assert.notEqual(guests, 99);
  });

  it('database: the tenant setting does not leak between pooled connections', async () => {
    await withTenant(ctx.db, f.bagh.restaurant_id, async (tx) => tx.query('SELECT 1'));
    const r = await ctx.db.query(`SELECT current_setting('app.restaurant_id', true) AS v`);
    assert.ok(!r.rows[0].v, 'tenant id survived the transaction');
  });

  it('http: B manager cannot fetch, modify or pay A orders by id (404, not 403)', async () => {
    const b = api(ctx, await login(ctx, 'bagh'));
    const [{ id: aOrder }] = await f.q(`SELECT id FROM orders WHERE restaurant_id = $1 AND status = 'open' LIMIT 1`, [f.saadat.restaurant_id]);
    const [{ id: aItem }] = await f.q(`SELECT id FROM order_items WHERE order_id = $1 LIMIT 1`, [aOrder]);
    const [{ id: aMenu }] = await f.q(`SELECT id FROM menu_items WHERE restaurant_id = $1 LIMIT 1`, [f.saadat.restaurant_id]);
    assert.equal((await b.get(`/api/orders/${aOrder}`)).status, 404);
    assert.equal((await b.post(`/api/orders/${aOrder}/items`, { requestId: uuid(), items: [{ menuItemId: aMenu, qty: 1 }] })).status, 404);
    assert.equal((await b.post(`/api/orders/${aOrder}/payments`, { method: 'cash', amount: 1000, orderVersion: 1, idempotencyKey: uuid() })).status, 404);
    assert.equal((await b.patch(`/api/order-items/${aItem}/status`, { to: 'ready', version: 1 })).status, 404);
    assert.equal((await b.patch(`/api/menu/items/${aMenu}`, { price: 1 })).status, 404);
    const menu = await b.get('/api/menu');
    assert.ok(!JSON.stringify(menu.body).includes('چلوکباب'), 'B menu contains A items');
  });

  it('http: B cannot ask for A branch data (floor, kitchen, report are empty or refused)', async () => {
    const b = api(ctx, await login(ctx, 'bagh'));
    const floor = await b.get(`/api/floor?branchId=${f.saadat.id}`);
    assert.deepEqual(floor.body.tables ?? [], []);
    const report = await b.get(`/api/reports/day?branchId=${f.saadat.id}&date=2026-10-20`);
    assert.equal(report.body.metrics?.summary?.orders ?? 0, 0);
  });

  it('http: branch-pinned staff cannot read another branch of the same restaurant', async () => {
    const ali = api(ctx, await login(ctx, 'ali')); // Saadat
    const [vanak] = await f.q(`SELECT id FROM branches WHERE name = 'نارنج ونک'`);
    assert.equal((await ali.get(`/api/floor?branchId=${vanak.id}`)).status, 403);
  });

  it('http: forged or expired session cookies are rejected', async () => {
    const forged = signSession({ uid: uuid(), rid: f.bagh.restaurant_id, exp: Math.floor(Date.now() / 1000) + 600 }, 'attacker-secret-attacker-secret-0000');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `mz_session=${forged}` } });
    assert.equal(res.statusCode, 401);
    const noCookie = await ctx.app.inject({ method: 'GET', url: '/api/floor?branchId=' + f.saadat.id });
    assert.equal(noCookie.statusCode, 401);
  });
  it('http: roles are enforced on the server (kitchen cannot read the floor or pay; floor cannot read the kitchen or reports)', async () => {
    const reza = api(ctx, await login(ctx, 'reza'));
    const ali = api(ctx, await login(ctx, 'ali'));
    assert.equal((await reza.get(`/api/floor?branchId=${f.saadat.id}`)).status, 403);
    assert.equal((await ali.get(`/api/kitchen?branchId=${f.saadat.id}`)).status, 403);
    const [{ id: tbl }] = await f.q(`SELECT id FROM dining_tables WHERE branch_id = $1 LIMIT 1`, [f.saadat.id]);
    assert.equal((await reza.post('/api/orders', { branchId: f.saadat.id, tableId: tbl, kind: 'dine_in', guests: 1 })).status, 403);
    assert.equal((await ali.patch(`/api/menu/items/${uuid()}`, { available: false })).status, 403);
  });

  it('http: cross-origin state-changing requests are refused; wrong password is a generic 401', async () => {
    const evil = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'https://evil.example', host: 'testabr.ai-synapse.ir' } });
    assert.equal(evil.statusCode, 403);
    const same = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'https://testabr.ai-synapse.ir', host: 'testabr.ai-synapse.ir' } });
    assert.equal(same.statusCode, 200);
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'sara', password: 'wrong' } });
    const unknown = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nobody', password: 'wrong' } });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.body, unknown.body, 'unknown user and wrong password must be indistinguishable');
  });
  it('http: login limit holds when the attacker rotates X-Forwarded-For', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 34; i++) {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'victim-ratelimit', password: 'x' + i }, headers: { 'x-forwarded-for': `10.0.${i}.1` } });
      codes.push(r.statusCode);
    }
    assert.ok(codes.slice(0, 30).every((c) => c === 401), 'first 30 are normal failures');
    assert.ok(codes.slice(30).every((c) => c === 429), 'then blocked even with a new apparent IP each time');
  });
});
