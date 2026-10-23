// One full shift for one table, end to end through the HTTP API: the workflow a restaurant actually runs.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, fixtures, login, setup, uuid, type Ctx } from './helpers.js';

describe('full service workflow', () => {
  let ctx: Ctx;
  before(async () => { ctx = await setup(); });
  after(() => ctx.close());

  it('table -> order -> kitchen -> served -> discount -> split payment -> closed -> reported', async () => {
    const f = await fixtures(ctx);
    const ali = api(ctx, await login(ctx, 'ali'));
    const maryam = api(ctx, await login(ctx, 'maryam'));
    const reza = api(ctx, await login(ctx, 'reza'));
    const sara = api(ctx, await login(ctx, 'sara'));

    // 1. floor shows the table free; waiter opens it
    const tableId = await f.freeTable(f.saadat.id);
    const floor0 = (await ali.get(`/api/floor?branchId=${f.saadat.id}`)).body;
    assert.equal(floor0.tables.find((t: any) => t.id === tableId).order, null);
    const opened = await ali.post('/api/orders', { branchId: f.saadat.id, tableId, kind: 'dine_in', guests: 2 });
    assert.equal(opened.status, 201);
    const orderId = opened.body.order.id;

    // 2. two rounds: food (kitchen) + drinks (bar)
    const kebab = await f.menuItem(f.saadat.restaurant_id, 'چلوکباب کوبیده (۲ سیخ)');
    const latte = await f.menuItem(f.saadat.restaurant_id, 'لاته');
    await ali.post(`/api/orders/${orderId}/items`, { requestId: uuid(), items: [{ menuItemId: kebab.id, qty: 2, note: 'بدون پیاز' }] });
    await ali.post(`/api/orders/${orderId}/items`, { requestId: uuid(), items: [{ menuItemId: latte.id, qty: 2 }] });

    // 3. kitchen board shows them; kitchen cannot touch money
    const board = (await reza.get(`/api/kitchen?branchId=${f.saadat.id}&station=kitchen`)).body.items.filter((i: any) => i.orderId === orderId);
    assert.equal(board.length, 1);
    assert.equal(board[0].note, 'بدون پیاز');
    assert.equal((await reza.post(`/api/orders/${orderId}/payments`, { method: 'cash', amount: 1000, orderVersion: 1, idempotencyKey: uuid() })).status, 403);

    // 4. kitchen advances everything; waiter cannot skip kitchen states
    let order = (await ali.get(`/api/orders/${orderId}`)).body.order;
    assert.equal((await ali.patch(`/api/order-items/${order.items[0].id}/status`, { to: 'ready', version: order.items[0].version })).status, 403);
    for (const it of order.items) {
      const a = await reza.patch(`/api/order-items/${it.id}/status`, { to: 'preparing', version: it.version });
      assert.equal(a.status, 200);
      const cur = a.body.order.items.find((x: any) => x.id === it.id);
      assert.equal((await reza.patch(`/api/order-items/${it.id}/status`, { to: 'ready', version: cur.version })).status, 200);
    }

    // 5. waiter serves, customer asks for the bill
    order = (await ali.get(`/api/orders/${orderId}`)).body.order;
    for (const it of order.items) assert.equal((await ali.patch(`/api/order-items/${it.id}/status`, { to: 'served', version: it.version })).status, 200);
    const billReq = await ali.post(`/api/orders/${orderId}/bill-request`);
    assert.ok(billReq.body.order.billRequestedAt);
    const floor1 = (await ali.get(`/api/floor?branchId=${f.saadat.id}`)).body;
    assert.ok(floor1.tables.find((t: any) => t.id === tableId).order.billRequestedAt);

    // 6. cashier applies a 10% discount, then pays half by card and half by cash
    order = (await maryam.get(`/api/orders/${orderId}`)).body.order;
    const subtotal = 2 * kebab.price + 2 * latte.price;
    assert.equal(order.totals.subtotal, subtotal);
    const disc = await maryam.put(`/api/orders/${orderId}/discount`, { kind: 'percent', value: 10, reason: 'مشتری دائمی', version: order.version });
    assert.equal(disc.status, 200);
    order = disc.body.order;
    const taxable = subtotal - Math.floor(subtotal / 10);
    const service = Math.round(taxable * 0.1);
    const vat = Math.round(((taxable + service) * 10) / 100);
    assert.deepEqual(order.totals, { subtotal, discount: Math.floor(subtotal / 10), service, vat, total: taxable + service + vat });
    const half = Math.floor(order.totals.total / 2);
    const p1 = await maryam.post(`/api/orders/${orderId}/payments`, { method: 'card', amount: half, orderVersion: order.version, idempotencyKey: uuid() });
    assert.equal(p1.body.order.status, 'open');
    assert.equal(p1.body.order.remaining, order.totals.total - half);
    const p2 = await maryam.post(`/api/orders/${orderId}/payments`, { method: 'cash', amount: p1.body.order.remaining, orderVersion: order.version, idempotencyKey: uuid() });
    assert.equal(p2.body.order.status, 'paid');

    // 7. table is free again, bill is frozen, no more changes allowed
    const floor2 = (await ali.get(`/api/floor?branchId=${f.saadat.id}`)).body;
    assert.equal(floor2.tables.find((t: any) => t.id === tableId).order, null);
    const late = await ali.post(`/api/orders/${orderId}/items`, { requestId: uuid(), items: [{ menuItemId: latte.id, qty: 1 }] });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'order_closed');

    // 8. manager's day report includes it, and the audit trail has the discount
    const today = new Date(Date.now() + 3.5 * 3600_000 - 4 * 3600_000).toISOString().slice(0, 10);
    const report = (await sara.get(`/api/reports/day?branchId=${f.saadat.id}&date=${today}`)).body;
    assert.ok(report.metrics.summary.orders >= 1);
    assert.ok(report.metrics.summary.sales >= order.totals.total, 'reported sales include this bill');
    const [{ n }] = await f.q(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'discount.set'`, [orderId]);
    assert.equal(n, 1);
    // floor staff cannot read reports
    assert.equal((await ali.get(`/api/reports/day?branchId=${f.saadat.id}&date=${today}`)).status, 403);
  });

  it('AI brief: provider failure falls back to the template; invented numbers are rejected', async () => {
    const { validateBrief } = await import('../services/ai.js');
    const facts = { date: '2026-10-20', orders: 70, sales: '۱۴۶٬۰۶۸٬۷۸۱ تومان', avgTicket: '۲٬۰۸۶٬۶۹۷ تومان', discountTotal: '۳٬۱۰۷٬۰۰۰ تومان', busiestHour: '۲۱ تا ۲۲', topItems: [], paymentShare: [], flags: [] };
    assert.doesNotThrow(() => validateBrief('فروش دیروز ۱۴۶٬۰۶۸٬۷۸۱ تومان بود و ۷۰ سفارش ثبت شد؛ مورد غیرعادی‌ای دیده نشد و روز آرامی بود.', facts));
    assert.throws(() => validateBrief('فروش دیروز ۱۹۹٬۰۰۰٬۰۰۰ تومان بود و ۷۰ سفارش ثبت شد؛ مورد غیرعادی‌ای دیده نشد و روز آرامی بود.', facts), /unknown number/);
    assert.throws(() => validateBrief('برای جزئیات به https://evil.example مراجعه کنید و فروش ۱۴۶٬۰۶۸٬۷۸۱ تومان بود و همه‌چیز خوب است.', facts), /link/);

    const sara = api(ctx, await login(ctx, 'sara')); // AI_API_KEY is unset in tests -> provider "fails"
    const f = await fixtures(ctx);
    const yesterday = new Date(Date.now() + 3.5 * 3600_000 - 28 * 3600_000).toISOString().slice(0, 10);
    const r = await sara.post('/api/reports/day/brief', { branchId: f.saadat.id, date: yesterday });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'template');
    assert.ok(r.body.text.length > 40);
  });
});
