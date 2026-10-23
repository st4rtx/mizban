// Menu and floor setup: who may do it, that it cannot cross restaurants, and that the result is usable in service.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, fixtures, login, setup, uuid, type Ctx } from './helpers.js';

describe('menu and floor setup', () => {
  let ctx: Ctx;
  let f: Awaited<ReturnType<typeof fixtures>>;
  let sara: ReturnType<typeof api>, ali: ReturnType<typeof api>, reza: ReturnType<typeof api>, bagh: ReturnType<typeof api>;
  before(async () => {
    ctx = await setup();
    f = await fixtures(ctx);
    sara = api(ctx, await login(ctx, 'sara'));
    ali = api(ctx, await login(ctx, 'ali'));
    reza = api(ctx, await login(ctx, 'reza'));
    bagh = api(ctx, await login(ctx, 'bagh'));
  });
  after(() => ctx.close());

  const firstCategory = async (who = sara) => (await who.get('/api/menu')).body.categories[0] as { id: string; name: string; items: unknown[] };

  describe('menu items', () => {
    it('manager adds an item; it shows in the menu and can be ordered right away', async () => {
      const cat = await firstCategory();
      const r = await sara.post('/api/menu/items', { categoryId: cat.id, name: '  غذای   روز: لوبیاپلو ', price: 380000, station: 'kitchen', prepMinutes: 12, description: 'با ماست' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.item.name, 'غذای روز: لوبیاپلو', 'whitespace is normalised');
      const menu = (await ali.get('/api/menu')).body;
      assert.ok(menu.categories.flatMap((c: any) => c.items).some((i: any) => i.id === r.body.item.id && i.available), 'floor staff see it');
      const tableId = await f.freeTable(f.saadat.id);
      const order = (await ali.post('/api/orders', { branchId: f.saadat.id, tableId, kind: 'dine_in', guests: 1 })).body.order;
      const added = await ali.post(`/api/orders/${order.id}/items`, { requestId: uuid(), items: [{ menuItemId: r.body.item.id, qty: 2 }] });
      assert.equal(added.status, 200);
      assert.equal(added.body.order.totals.subtotal, 760000);
      const [{ n }] = await f.q(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'menu.create' AND entity_id = $1`, [r.body.item.id]);
      assert.equal(n, 1);
    });

    it('Arabic ي/ك typed by a manager are stored as Persian ی/ک', async () => {
      const cat = await firstCategory();
      const r = await sara.post('/api/menu/items', { categoryId: cat.id, name: 'كباب ديگ', price: 1000, station: 'kitchen' });
      assert.equal(r.body.item.name, 'کباب دیگ');
    });

    it('duplicate names are refused, case and spacing aside', async () => {
      const cat = await firstCategory();
      const first = await sara.post('/api/menu/items', { categoryId: cat.id, name: 'Special Soup', price: 1000, station: 'kitchen' });
      assert.equal(first.status, 201);
      const dup = await sara.post('/api/menu/items', { categoryId: cat.id, name: ' special   SOUP ', price: 2000, station: 'kitchen' });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, 'duplicate_name');
    });

    it('only managers: floor and kitchen get 403', async () => {
      const cat = await firstCategory();
      const body = { categoryId: cat.id, name: 'نباید بشود', price: 1000, station: 'kitchen' };
      assert.equal((await ali.post('/api/menu/items', body)).status, 403);
      assert.equal((await reza.post('/api/menu/items', body)).status, 403);
      assert.equal((await ali.post('/api/menu/categories', { name: 'x' })).status, 403);
    });

    it('validates input at the boundary', async () => {
      const cat = await firstCategory();
      const bad = (over: object) => sara.post('/api/menu/items', { categoryId: cat.id, name: 'ok', price: 1000, station: 'kitchen', ...over });
      assert.equal((await bad({ price: -5 })).status, 400);
      assert.equal((await bad({ price: 1.5 })).status, 400);
      assert.equal((await bad({ name: '   ' })).status, 400);
      assert.equal((await bad({ station: 'roof' })).status, 400);
      assert.equal((await bad({ prepMinutes: 0 })).status, 400);
      assert.equal((await bad({ categoryId: 'not-a-uuid' })).status, 400);
    });

    it("another restaurant's manager cannot add into this restaurant's category", async () => {
      const cat = await firstCategory(sara);
      const r = await bagh.post('/api/menu/items', { categoryId: cat.id, name: 'نفوذ', price: 1000, station: 'bar' });
      assert.equal(r.status, 404);
      const [{ n }] = await f.q(`SELECT count(*)::int AS n FROM menu_items WHERE name = 'نفوذ'`);
      assert.equal(n, 0);
    });

    it('adds a category, then an item inside it; a duplicate category is refused', async () => {
      const c = await sara.post('/api/menu/categories', { name: 'غذای روز', icon: '🍛' });
      assert.equal(c.status, 201);
      const i = await sara.post('/api/menu/items', { categoryId: c.body.category.id, name: 'آش رشته', price: 190000, station: 'kitchen' });
      assert.equal(i.status, 201);
      const menu = (await ali.get('/api/menu')).body.categories;
      assert.equal(menu[menu.length - 1].name, 'غذای روز', 'new category goes last');
      assert.equal((await sara.post('/api/menu/categories', { name: 'غذای  روز' })).status, 409);
    });
  });

  describe('tables and zones', () => {
    it('manager adds three tables to a brand-new zone; numbers continue, floor staff see them', async () => {
      const before = (await sara.get(`/api/admin/tables?branchId=${f.saadat.id}`)).body.tables;
      const maxNum = Math.max(...before.map((t: any) => Number(t.label)));
      const r = await sara.post('/api/admin/tables', { branchId: f.saadat.id, zone: 'پشت‌بام', seats: 6, count: 3 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(r.body.tables.map((t: any) => t.label), [maxNum + 1, maxNum + 2, maxNum + 3].map(String));
      const floor = (await ali.get(`/api/floor?branchId=${f.saadat.id}`)).body.tables;
      const roof = floor.filter((t: any) => t.zone === 'پشت‌بام');
      assert.equal(roof.length, 3);
      assert.ok(roof.every((t: any) => t.seats === 6 && t.order === null));
      const zoneOrder = [...new Set(floor.map((t: any) => t.zone))];
      assert.equal(zoneOrder[zoneOrder.length - 1], 'پشت‌بام', 'a new zone is listed after the existing ones');
    });

    it('a table added to an existing zone sorts inside that zone', async () => {
      const r = await sara.post('/api/admin/tables', { branchId: f.saadat.id, zone: 'تراس', seats: 2 });
      assert.equal(r.status, 201);
      const floor = (await ali.get(`/api/floor?branchId=${f.saadat.id}`)).body.tables;
      const idx = floor.map((t: any) => t.id);
      const terrace = floor.filter((t: any) => t.zone === 'تراس');
      assert.equal(idx.indexOf(r.body.tables[0].id), idx.indexOf(terrace[terrace.length - 1].id), 'it is the last one of the terrace');
      assert.ok(terrace.length >= 7);
    });

    it('two managers adding tables at the same moment never get the same number', async () => {
      const calls = await Promise.all(Array.from({ length: 6 }, () => sara.post('/api/admin/tables', { branchId: f.saadat.id, zone: 'همزمان', seats: 4 })));
      assert.ok(calls.every((c) => c.status === 201), JSON.stringify(calls.map((c) => c.status)));
      const labels = calls.map((c) => c.body.tables[0].label);
      assert.equal(new Set(labels).size, 6);
    });

    it('a custom label works for one table; a taken label is refused', async () => {
      const ok = await sara.post('/api/admin/tables', { branchId: f.saadat.id, zone: 'اتاق خصوصی', seats: 10, label: 'VIP' });
      assert.equal(ok.status, 201);
      const dup = await sara.post('/api/admin/tables', { branchId: f.saadat.id, zone: 'اتاق خصوصی', seats: 10, label: 'VIP' });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, 'duplicate_label');
    });

    it('edits label, zone and seats', async () => {
      const t = (await sara.post('/api/admin/tables', { branchId: f.saadat.id, zone: 'ویرایش', seats: 4 })).body.tables[0];
      const r = await sara.patch(`/api/admin/tables/${t.id}`, { label: 'E1', zone: 'ویرایش‌شده', seats: 8 });
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.table.label, r.body.table.zone, r.body.table.seats], ['E1', 'ویرایش‌شده', 8]);
      const [{ n }] = await f.q(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'table.update'`, [t.id]);
      assert.equal(n, 1);
    });

    it('a table with an open order cannot be taken out of service; a free one can, and it leaves the floor', async () => {
      const busyId = await f.freeTable(f.saadat.id);
      await ali.post('/api/orders', { branchId: f.saadat.id, tableId: busyId, kind: 'dine_in', guests: 2 });
      const refused = await sara.patch(`/api/admin/tables/${busyId}`, { active: false });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, 'table_busy');

      const free = (await sara.post('/api/admin/tables', { branchId: f.saadat.id, zone: 'موقت', seats: 2 })).body.tables[0];
      assert.equal((await sara.patch(`/api/admin/tables/${free.id}`, { active: false })).status, 200);
      const floor = (await ali.get(`/api/floor?branchId=${f.saadat.id}`)).body.tables;
      assert.ok(!floor.some((t: any) => t.id === free.id), 'inactive table is off the floor');
      const open = await ali.post('/api/orders', { branchId: f.saadat.id, tableId: free.id, kind: 'dine_in', guests: 1 });
      assert.equal(open.status, 404, 'and cannot be opened');
      assert.equal((await sara.patch(`/api/admin/tables/${free.id}`, { active: true })).status, 200);
      assert.ok((await ali.get(`/api/floor?branchId=${f.saadat.id}`)).body.tables.some((t: any) => t.id === free.id));
    });

    it('renames a zone for the whole branch, and only that branch', async () => {
      const [vanak] = await f.q(`SELECT id FROM branches WHERE name = 'نارنج ونک'`);
      const r = await sara.patch('/api/admin/zones', { branchId: f.saadat.id, from: 'سالن اصلی', to: 'سالن مرکزی' });
      assert.equal(r.status, 200);
      assert.ok(r.body.renamed >= 12);
      const s = (await sara.get(`/api/admin/tables?branchId=${f.saadat.id}`)).body.tables;
      assert.ok(!s.some((t: any) => t.zone === 'سالن اصلی'));
      assert.ok(s.some((t: any) => t.zone === 'سالن مرکزی'));
      const v = (await sara.get(`/api/admin/tables?branchId=${vanak.id}`)).body.tables;
      assert.ok(v.every((t: any) => t.zone !== 'سالن مرکزی'), 'the other branch is untouched');
      assert.equal((await sara.patch('/api/admin/zones', { branchId: f.saadat.id, from: 'بخش ناموجود', to: 'x' })).status, 404);
    });

    it('only managers; branch-pinned and other-restaurant users are kept out', async () => {
      const body = { branchId: f.saadat.id, zone: 'نفوذ', seats: 4 };
      assert.equal((await ali.post('/api/admin/tables', body)).status, 403);
      assert.equal((await reza.get(`/api/admin/tables?branchId=${f.saadat.id}`)).status, 403);
      const t = (await sara.get(`/api/admin/tables?branchId=${f.saadat.id}`)).body.tables[0];
      assert.equal((await bagh.patch(`/api/admin/tables/${t.id}`, { seats: 1 })).status, 404);
      assert.equal((await bagh.post('/api/admin/tables', body)).status, 404, 'foreign branch id looks like it does not exist');
      assert.deepEqual((await bagh.get(`/api/admin/tables?branchId=${f.saadat.id}`)).body.tables, []);
      const [{ n }] = await f.q(`SELECT count(*)::int AS n FROM dining_tables WHERE zone = 'نفوذ'`);
      assert.equal(n, 0);
    });

    it('caps a branch at 200 tables and rejects nonsense', async () => {
      assert.equal((await sara.post('/api/admin/tables', { branchId: f.saadat.id, zone: 'x', seats: 4, count: 51 })).status, 400);
      assert.equal((await sara.post('/api/admin/tables', { branchId: f.saadat.id, zone: 'x', seats: 0 })).status, 400);
      assert.equal((await sara.post('/api/admin/tables', { branchId: f.saadat.id, zone: '  ', seats: 4 })).status, 400);
      let last = 201;
      for (let i = 0; i < 5 && last === 201; i++) last = (await sara.post('/api/admin/tables', { branchId: f.saadat.id, zone: 'سقف', seats: 2, count: 50 })).status;
      assert.equal(last, 400, 'the per-branch cap eventually refuses');
    });
  });
});
