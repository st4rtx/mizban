// The "room full of people touching the same thing" tests. Real Postgres, real parallel requests.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, fixtures, login, setup, uuid, type Ctx } from './helpers.js';

describe('concurrent service', () => {
  let ctx: Ctx;
  let f: Awaited<ReturnType<typeof fixtures>>;
  let ali: ReturnType<typeof api>, maryam: ReturnType<typeof api>, reza: ReturnType<typeof api>, sara: ReturnType<typeof api>;
  let kebab: { id: string; price: number }, latte: { id: string; price: number }, pizza: { id: string; price: number };
  before(async () => {
    ctx = await setup();
    f = await fixtures(ctx);
    ali = api(ctx, await login(ctx, 'ali'));
    maryam = api(ctx, await login(ctx, 'maryam'));
    reza = api(ctx, await login(ctx, 'reza'));
    sara = api(ctx, await login(ctx, 'sara'));
    kebab = await f.menuItem(f.saadat.restaurant_id, 'چلوکباب کوبیده (۲ سیخ)');
    latte = await f.menuItem(f.saadat.restaurant_id, 'لاته');
    pizza = await f.menuItem(f.saadat.restaurant_id, 'پیتزا مخصوص (۳۰ سانتی)');
  });
  after(() => ctx.close());

  const openTable = async (who = ali) => {
    const tableId = await f.freeTable(f.saadat.id);
    const r = await who.post('/api/orders', { branchId: f.saadat.id, tableId, kind: 'dine_in', guests: 2 });
    return r.body.order as { id: string; version: number; tableId: string };
  };

  it('two waiters opening the same table at once end up on ONE order', async () => {
    const tableId = await f.freeTable(f.saadat.id);
    const body = { branchId: f.saadat.id, tableId, kind: 'dine_in', guests: 2 };
    const results = await Promise.all([ali.post('/api/orders', body), maryam.post('/api/orders', body), ali.post('/api/orders', body), maryam.post('/api/orders', body)]);
    assert.ok(results.every((r) => r.status === 200 || r.status === 201));
    assert.equal(new Set(results.map((r) => r.body.order.id)).size, 1);
    assert.equal(results.filter((r) => r.status === 201).length, 1, 'exactly one request created it');
    const [{ n }] = await f.q(`SELECT count(*)::int AS n FROM orders WHERE table_id = $1 AND status = 'open'`, [tableId]);
    assert.equal(n, 1);
  });

  it('20 simultaneous "add to table 12" requests lose nothing', async () => {
    const order = await openTable();
    const calls = Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? ali : maryam).post(`/api/orders/${order.id}/items`, { requestId: uuid(), items: [{ menuItemId: i % 3 ? latte.id : pizza.id, qty: 1 }] }),
    );
    const res = await Promise.all(calls);
    assert.ok(res.every((r) => r.status === 200), JSON.stringify(res.find((r) => r.status !== 200)?.body));
    const got = (await ali.get(`/api/orders/${order.id}`)).body.order;
    assert.equal(got.items.length, 20);
    const expected = 7 * pizza.price + 13 * latte.price; // i%3==0 for i in 0..19 -> 7 pizzas
    assert.equal(got.totals.subtotal, expected);
  });

  it('a retried "send" (flaky Wi-Fi, same requestId) is applied once', async () => {
    const order = await openTable();
    const requestId = uuid();
    const payload = { requestId, items: [{ menuItemId: kebab.id, qty: 2 }] };
    const rs = await Promise.all([ali.post(`/api/orders/${order.id}/items`, payload), ali.post(`/api/orders/${order.id}/items`, payload), ali.post(`/api/orders/${order.id}/items`, payload)]);
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal((await ali.get(`/api/orders/${order.id}`)).body.order.items.length, 1);
  });

  it('kitchen starts a dish while the waiter cancels it: exactly one wins, no corrupt state', async () => {
    const order = await openTable();
    const added = await ali.post(`/api/orders/${order.id}/items`, { requestId: uuid(), items: [{ menuItemId: kebab.id, qty: 1 }] });
    const item = added.body.order.items[0];
    const [start, cancel] = await Promise.all([
      reza.patch(`/api/order-items/${item.id}/status`, { to: 'preparing', version: item.version }),
      ali.post(`/api/order-items/${item.id}/void`, { reason: null, version: item.version }),
    ]);
    const outcomes = [start.status, cancel.status].sort();
    assert.deepEqual(outcomes, [200, 409], `got ${start.status}/${cancel.status}`);
    const final = (await ali.get(`/api/orders/${order.id}`)).body.order.items[0];
    assert.ok(['preparing', 'void'].includes(final.status));
    const loser = start.status === 409 ? start : cancel;
    assert.ok(['item_changed', 'forbidden'].includes(loser.body.error.code) || loser.status === 409);
    // totals match whichever won
    const o = (await ali.get(`/api/orders/${order.id}`)).body.order;
    assert.equal(o.totals.subtotal, final.status === 'void' ? 0 : kebab.price);
  });

  it('two kitchen taps on the same dish with the same version: one applies, the other is told', async () => {
    const order = await openTable();
    const item = (await ali.post(`/api/orders/${order.id}/items`, { requestId: uuid(), items: [{ menuItemId: kebab.id, qty: 1 }] })).body.order.items[0];
    const rs = await Promise.all([reza.patch(`/api/order-items/${item.id}/status`, { to: 'ready', version: item.version }), sara.patch(`/api/order-items/${item.id}/status`, { to: 'preparing', version: item.version })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  });

  it('cashier sees a total, a waiter adds a pizza, payment of the OLD total is refused', async () => {
    const order = await openTable();
    const first = (await ali.post(`/api/orders/${order.id}/items`, { requestId: uuid(), items: [{ menuItemId: latte.id, qty: 2 }] })).body.order;
    // cashier loads the bill: version is first.version
    await ali.post(`/api/orders/${order.id}/items`, { requestId: uuid(), items: [{ menuItemId: pizza.id, qty: 1 }] });
    const pay = await maryam.post(`/api/orders/${order.id}/payments`, { method: 'cash', amount: first.totals.total, orderVersion: first.version, idempotencyKey: uuid() });
    assert.equal(pay.status, 409);
    assert.equal(pay.body.error.code, 'bill_changed');
    assert.equal(pay.body.error.details.current.status, 'open', 'table must not be closed short');
    const [{ n }] = await f.q('SELECT count(*)::int AS n FROM payments WHERE order_id = $1', [order.id]);
    assert.equal(n, 0);
  });

  it('payment racing "add item": either the item is on the paid bill or the payment is refused, never both missing', async () => {
    const order = await openTable();
    const base = (await ali.post(`/api/orders/${order.id}/items`, { requestId: uuid(), items: [{ menuItemId: latte.id, qty: 1 }] })).body.order;
    for (const it of base.items) await reza.patch(`/api/order-items/${it.id}/status`, { to: 'ready', version: it.version });
    const fresh = (await ali.get(`/api/orders/${order.id}`)).body.order;
    const [pay, add] = await Promise.all([
      maryam.post(`/api/orders/${order.id}/payments`, { method: 'card', amount: fresh.totals.total, orderVersion: fresh.version, idempotencyKey: uuid() }),
      ali.post(`/api/orders/${order.id}/items`, { requestId: uuid(), items: [{ menuItemId: pizza.id, qty: 1 }] }),
    ]);
    const o = (await ali.get(`/api/orders/${order.id}`)).body.order;
    if (pay.status === 200 && add.status === 200) assert.fail('both succeeded: the pizza was added after the bill was settled without the cashier knowing');
    if (pay.status === 200) {
      assert.equal(o.status, 'paid');
      assert.equal(o.items.length, 1);
      assert.equal(add.status, 409);
    } else {
      assert.equal(pay.status, 409);
      assert.equal(o.status, 'open');
      assert.equal(o.items.length, 2);
    }
  });

  it('a double-tapped payment (same idempotency key) records once; split payments sum exactly to the total', async () => {
    const order = await openTable();
    const o1 = (await ali.post(`/api/orders/${order.id}/items`, { requestId: uuid(), items: [{ menuItemId: kebab.id, qty: 3 }] })).body.order;
    for (const it of o1.items) {
      await reza.patch(`/api/order-items/${it.id}/status`, { to: 'ready', version: it.version });
    }
    const o = (await ali.get(`/api/orders/${order.id}`)).body.order;
    const half = Math.floor(o.totals.total / 2);
    const key = uuid();
    const tap = { method: 'card', amount: half, orderVersion: o.version, idempotencyKey: key };
    const rs = await Promise.all([maryam.post(`/api/orders/${order.id}/payments`, tap), maryam.post(`/api/orders/${order.id}/payments`, tap), maryam.post(`/api/orders/${order.id}/payments`, tap)]);
    assert.ok(rs.every((r) => r.status === 200));
    const mid = (await ali.get(`/api/orders/${order.id}`)).body.order;
    assert.equal(mid.paidAmount, half);
    assert.equal(mid.status, 'open');
    const over = await maryam.post(`/api/orders/${order.id}/payments`, { method: 'cash', amount: mid.remaining + 1, orderVersion: mid.version, idempotencyKey: uuid() });
    assert.equal(over.status, 400, 'overpay must be refused');
    const last = await maryam.post(`/api/orders/${order.id}/payments`, { method: 'cash', amount: mid.remaining, orderVersion: mid.version, idempotencyKey: uuid() });
    assert.equal(last.status, 200);
    assert.equal(last.body.order.status, 'paid');
    const [{ s }] = await f.q('SELECT sum(amount)::int AS s FROM payments WHERE order_id = $1', [order.id]);
    assert.equal(s, o.totals.total);
  });

  it('discount edits race on version; floor staff cannot exceed their cap', async () => {
    const order = await openTable();
    const o = (await ali.post(`/api/orders/${order.id}/items`, { requestId: uuid(), items: [{ menuItemId: kebab.id, qty: 2 }] })).body.order;
    const tooMuch = await maryam.put(`/api/orders/${order.id}/discount`, { kind: 'percent', value: 30, reason: 'تست', version: o.version });
    assert.equal(tooMuch.status, 403);
    const rs = await Promise.all([
      maryam.put(`/api/orders/${order.id}/discount`, { kind: 'percent', value: 10, reason: 'مشتری دائمی', version: o.version }),
      sara.put(`/api/orders/${order.id}/discount`, { kind: 'percent', value: 20, reason: 'مهمان', version: o.version }),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    const [{ n }] = await f.q(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'discount.set'`, [order.id]);
    assert.equal(n, 1, 'only the winning discount is audited');
  });
});
