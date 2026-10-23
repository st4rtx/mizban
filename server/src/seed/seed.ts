/**
 * Demo data: two restaurants (one with two branches), staff, menus, 30 days of paid history,
 * and a live evening in progress. Deterministic (seeded PRNG) so the demo looks the same every deploy.
 * Docs: /docs/features/demo-data.md
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../db/migrate.js';
import { computeTotals } from '../lib/money.js';
import { hashPassword } from '../lib/password.js';
import { BAGH_MENU, NARENJ_MENU, type MenuSeed } from './menu.js';

type Client = pg.Client;
const TEHRAN_OFFSET_MS = 3.5 * 3600_000;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261023);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
function weighted<T>(a: T[], w: (x: T) => number): T {
  const total = a.reduce((s, x) => s + w(x), 0);
  let r = rnd() * total;
  for (const x of a) if ((r -= w(x)) <= 0) return x;
  return a[a.length - 1];
}
const between = (a: number, b: number) => a + rnd() * (b - a);

/** Tehran wall-clock (date, fractional hour) to a UTC Date. */
const tehran = (dateStr: string, hour: number) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0) + hour * 3600_000 - TEHRAN_OFFSET_MS);
};
const tehranDate = (d: Date) => new Date(d.getTime() + TEHRAN_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (dateStr: string, n: number) => new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
const weekday = (dateStr: string) => new Date(Date.parse(dateStr + 'T00:00:00Z')).getUTCDay(); // 0 = Sunday

async function bulk(c: Client, table: string, cols: string[], rows: unknown[][], chunk = 400) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = part
      .map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`)
      .join(',');
    await c.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values}`, params);
  }
}

interface MenuRow { id: string; name: string; price: number; station: 'kitchen' | 'bar'; prep: number; weight: number; slot: string; available: boolean }
interface Staff { id: string; name: string; role: string; branch: string }

async function createMenu(c: Client, restaurantId: string, def: typeof NARENJ_MENU, unavailable: string[]): Promise<MenuRow[]> {
  const rows: MenuRow[] = [];
  let ci = 0;
  for (const cat of def) {
    const catId = randomUUID();
    await c.query('INSERT INTO menu_categories (id, restaurant_id, name, icon, sort) VALUES ($1,$2,$3,$4,$5)', [catId, restaurantId, cat.name, cat.icon, ci++]);
    let si = 0;
    for (const [name, price, station, prep, weight, desc] of cat.items as MenuSeed[]) {
      const id = randomUUID();
      const available = !unavailable.includes(name);
      await c.query(
        `INSERT INTO menu_items (id, restaurant_id, category_id, name, description, price, station, prep_minutes, available, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, restaurantId, catId, name, desc ?? null, price, station, prep, available, si++],
      );
      rows.push({ id, name, price, station, prep, weight, slot: cat.slot, available });
    }
  }
  return rows;
}

const SLOTS = [
  { from: 9, to: 11.25, share: 0.13, mains: ['breakfast'], drinkP: 0.9 },
  { from: 13, to: 15.5, share: 0.3, mains: ['main'], drinkP: 0.7 },
  { from: 16, to: 18.5, share: 0.15, mains: ['dessert', 'main'], drinkP: 1.1 },
  { from: 19.5, to: 22.75, share: 0.42, mains: ['main'], drinkP: 0.8 },
];
const DAY_BASE: Record<number, number> = { 6: 40, 0: 38, 1: 34, 2: 37, 3: 44, 4: 64, 5: 72 }; // Sat..Fri; Thursday night + Friday busiest

interface Plan {
  restaurantId: string; branchId: string; tables: { id: string }[]; menu: MenuRow[]; staff: Staff[];
  servicePct: number; vatPct: number; scale: number; days: number; today: string; nowMs: number;
}

function buildHistory(p: Plan) {
  const orders: unknown[][] = [];
  const items: unknown[][] = [];
  const pays: unknown[][] = [];
  const audits: unknown[][] = [];
  let seq = 0;
  const floors = p.staff.filter((s) => s.role === 'floor');
  const manager = p.staff.find((s) => s.role === 'manager')!;
  const bySlot = (slot: string) => p.menu.filter((m) => m.slot === slot);
  const yesterday = addDays(p.today, -1);

  for (let back = p.days; back >= 0; back--) {
    const day = addDays(p.today, -back);
    const isToday = back === 0;
    const n = Math.round(DAY_BASE[weekday(day)] * p.scale * between(0.85, 1.15));
    const day_orders: { open: Date; slot: (typeof SLOTS)[number] }[] = [];
    for (let i = 0; i < n; i++) {
      const slot = weighted(SLOTS, (s) => s.share);
      const open = tehran(day, between(slot.from, slot.to));
      day_orders.push({ open, slot });
    }
    day_orders.sort((a, b) => a.open.getTime() - b.open.getTime());
    let discountBudgetYesterday = back === 1 ? 14 : 0; // planted: one cashier discounting heavily yesterday
    let voidBudgetYesterday = back === 1 ? 3 : 0;
    for (const o of day_orders) {
      const takeaway = rnd() < 0.15;
      const guests = takeaway ? 1 : weighted([1, 2, 3, 4, 5, 6], (g) => [0.12, 0.38, 0.16, 0.2, 0.08, 0.06][g - 1]);
      const dineMinutes = takeaway ? between(6, 14) : between(45, 95);
      const closedAt = new Date(o.open.getTime() + dineMinutes * 60_000);
      if (isToday && closedAt.getTime() > p.nowMs - 25 * 60_000) continue; // today's history ends before the live service starts
      const orderId = randomUUID();
      const waiter = pick(floors.length ? floors : [manager]);
      seq++;
      // --- lines
      const lines = new Map<string, { m: MenuRow; qty: number }>();
      const add = (m: MenuRow, q = 1) => lines.set(m.id, { m, qty: (lines.get(m.id)?.qty ?? 0) + q });
      const mainSlot = pick(o.slot.mains);
      for (let g = 0; g < guests; g++) add(weighted(bySlot(mainSlot).length ? bySlot(mainSlot) : bySlot('main'), (m) => m.weight));
      const drinks = Math.round(guests * o.slot.drinkP * between(0.7, 1.3));
      for (let d = 0; d < drinks; d++) add(weighted(bySlot('drink'), (m) => m.weight));
      if (bySlot('starter').length && o.slot.from >= 13 && rnd() < 0.4) add(weighted(bySlot('starter'), (m) => m.weight));
      if (bySlot('dessert').length && o.slot.from >= 16 && rnd() < 0.3) add(weighted(bySlot('dessert'), (m) => m.weight));
      // --- items (slow kitchen planted yesterday evening)
      const slowFactor = back === 1 && o.slot.from >= 19 ? 2.1 : 1;
      let subtotal = 0;
      let line = 0;
      const itemRows: unknown[][] = [];
      let voidedHere = false;
      for (const { m, qty } of lines.values()) {
        const prep = m.prep * between(0.7, 1.7) * slowFactor;
        const createdAt = new Date(o.open.getTime() + between(0, 8) * 60_000);
        const readyAt = new Date(createdAt.getTime() + prep * 60_000);
        let status = 'served';
        let voidReason: string | null = null;
        let voidStage: string | null = null;
        let voidedBy: string | null = null;
        const quickVoid = rnd() < 0.012;
        const plantedVoid = voidBudgetYesterday > 0 && !voidedHere && m.price > 400000 && rnd() < 0.2;
        if (quickVoid || plantedVoid) {
          status = 'void';
          voidStage = plantedVoid ? (rnd() < 0.5 ? 'preparing' : 'served') : 'new';
          voidReason = plantedVoid ? 'شکایت مشتری از کیفیت' : 'اشتباه ثبت شد';
          voidedBy = plantedVoid ? manager.id : waiter.id;
          if (plantedVoid) { voidBudgetYesterday--; voidedHere = true; }
        } else subtotal += qty * m.price;
        itemRows.push([randomUUID(), p.restaurantId, orderId, m.id, m.name, m.price, m.station, qty, null, status, 1, 1, randomUUID(), line++, waiter.id, createdAt, status === 'void' ? null : readyAt, status === 'void' ? createdAt : readyAt, status === 'void' ? null : readyAt, voidStage, voidReason, voidedBy]);
        if (status === 'void') {
          audits.push([p.restaurantId, p.branchId, voidedBy, 'item.void', 'order_item', itemRows[itemRows.length - 1][0], JSON.stringify({ name: m.name, qty, value: qty * m.price, stage: voidStage, reason: voidReason }), createdAt]);
        }
      }
      if (subtotal === 0) { seq--; continue; }
      // --- discount
      let dKind: 'percent' | null = null, dVal = 0, dBy: string | null = null, dReason: string | null = null;
      const cashier = floors.find((f) => f.name.startsWith('مریم')) ?? waiter;
      if (back === 1 && discountBudgetYesterday > 0 && !takeaway && rnd() < 0.3) {
        dKind = 'percent'; dVal = 10; dBy = cashier.id; dReason = pick(['مشتری دائمی', 'تأخیر در سرو', 'دوست صاحب‌کار']); discountBudgetYesterday--;
      } else if (rnd() < 0.05) {
        dKind = 'percent'; dVal = pick([5, 10]); dBy = waiter.id; dReason = pick(['مشتری دائمی', 'تولد', 'کد معرفی']);
      } else if (rnd() < 0.006) {
        dKind = 'percent'; dVal = 25; dBy = manager.id; dReason = 'مهمان صاحب‌کار';
      }
      const t = computeTotals(subtotal, { kind: dKind, value: dVal }, p.servicePct, p.vatPct);
      if (dKind) audits.push([p.restaurantId, p.branchId, dBy, 'discount.set', 'order', orderId, JSON.stringify({ kind: dKind, value: dVal, amount: t.discount, subtotal, reason: dReason }), closedAt]);
      orders.push([orderId, p.restaurantId, p.branchId, takeaway ? null : pick(p.tables).id, takeaway ? 'takeaway' : 'dine_in', seq, 'paid', guests, waiter.id, o.open, closedAt, dKind, dVal, dReason, dBy, t.subtotal, t.discount, t.service, t.vat, t.total, 3]);
      items.push(...itemRows);
      // --- payments (12% split in two, mixed methods)
      const split = !takeaway && guests > 1 && rnd() < 0.18;
      const methods = ['card', 'card', 'cash', 'transfer'] as const;
      if (split) {
        const first = Math.round((t.total * between(0.35, 0.6)) / 1000) * 1000;
        pays.push([randomUUID(), p.restaurantId, orderId, pick([...methods]), first, cashier.id, closedAt, randomUUID()]);
        pays.push([randomUUID(), p.restaurantId, orderId, pick([...methods]), t.total - first, cashier.id, closedAt, randomUUID()]);
      } else pays.push([randomUUID(), p.restaurantId, orderId, pick([...methods]), t.total, cashier.id, closedAt, randomUUID()]);
    }
  }
  return { orders, items, pays, audits, seq };
}

/** A service in progress: open tables in every state so the floor, kitchen board and checkout all have something to do. */
function buildLive(p: Plan, startSeq: number, spec: { tableIdx: number; minutesAgo: number; lines: [string, number, number][]; bill?: boolean }[], takeaway: { minutesAgo: number; lines: [string, number, number][] }[]) {
  const orders: unknown[][] = [];
  const items: unknown[][] = [];
  const floors = p.staff.filter((s) => s.role === 'floor');
  let seq = startSeq;
  const byName = new Map(p.menu.map((m) => [m.name, m]));
  const mk = (tableId: string | null, minutesAgo: number, lines: [string, number, number][], bill: boolean, guests: number) => {
    const id = randomUUID();
    const opened = new Date(p.nowMs - minutesAgo * 60_000);
    const waiter = pick(floors);
    seq++;
    orders.push([id, p.restaurantId, p.branchId, tableId, tableId ? 'dine_in' : 'takeaway', seq, 'open', guests, waiter.id, opened, null, null, 0, null, null, null, null, null, null, null, 1 + lines.length, bill ? new Date(p.nowMs - 2 * 60_000) : null]);
    let line = 0;
    for (const [name, qty, ageMin] of lines) {
      const m = byName.get(name)!;
      const created = new Date(p.nowMs - ageMin * 60_000);
      // status follows how long it has been in the kitchen relative to its prep time
      const elapsed = ageMin;
      const status = elapsed >= m.prep * 3 ? 'served' : elapsed >= m.prep * 1.15 ? 'ready' : elapsed >= 2 ? 'preparing' : 'new';
      const readyAt = status === 'ready' || status === 'served' ? new Date(created.getTime() + m.prep * 60_000) : null;
      items.push([randomUUID(), p.restaurantId, id, m.id, m.name, m.price, m.station, qty, null, status, 1, 1, randomUUID(), line++, waiter.id, created, readyAt, readyAt ?? created, readyAt, null, null, null]);
    }
  };
  for (const s of spec) mk(p.tables[s.tableIdx].id, s.minutesAgo, s.lines, !!s.bill, 3);
  for (const t of takeaway) mk(null, t.minutesAgo, t.lines, false, 1);
  return { orders, items, seq };
}

const ORDER_COLS = ['id','restaurant_id','branch_id','table_id','kind','number','status','guests','opened_by','opened_at','closed_at','discount_kind','discount_value','discount_reason','discount_by','paid_subtotal','paid_discount','paid_service','paid_vat','paid_total','version'];
const ITEM_COLS = ['id','restaurant_id','order_id','menu_item_id','name','unit_price','station','qty','note','status','version','round','client_request_id','line_no','created_by','created_at','ready_at','status_at','ready_at_dup','void_stage','void_reason','voided_by'];

async function insertOrders(c: Client, orders: unknown[][], items: unknown[][], pays: unknown[][], audits: unknown[][], live: boolean) {
  if (live) {
    // live orders carry one extra column (bill_requested_at) and a custom version
    await bulk(c, 'orders', [...ORDER_COLS, 'bill_requested_at'], orders.map((o) => [...o.slice(0, 20), o[20], o[21]]));
  } else {
    await bulk(c, 'orders', ORDER_COLS, orders);
  }
  const itemCols = ITEM_COLS.filter((x) => x !== 'ready_at_dup');
  await bulk(c, 'order_items', itemCols, items.map((r) => { const x = [...r]; x.splice(18, 1); return x; }), 300);
  if (pays.length) await bulk(c, 'payments', ['id','restaurant_id','order_id','method','amount','created_by','created_at','idempotency_key'], pays);
  if (audits.length) await bulk(c, 'audit_log', ['restaurant_id','branch_id','actor_id','action','entity','entity_id','data','at'], audits);
}

export async function seed(adminUrl: string, appPassword: string, opts: { reset?: boolean } = {}) {
  await migrate(adminUrl, appPassword, () => undefined);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const exists = (await c.query(`SELECT 1 FROM restaurants WHERE slug = 'narenj'`)).rowCount;
    if (exists && !opts.reset) { console.log('seed: demo data already present (use --reset to rebuild)'); return; }
    await c.query('BEGIN');
    await c.query('TRUNCATE audit_log, day_briefs, payments, order_items, orders, menu_items, menu_categories, dining_tables, users, branches, restaurants RESTART IDENTITY CASCADE');
    const pw = await hashPassword('demo1234');
    const now = new Date();
    const today = tehranDate(now);
    const nowMs = now.getTime();

    // ---------------- Restaurant 1: Narenj, two branches ----------------
    const narenj = randomUUID();
    await c.query(`INSERT INTO restaurants (id, name, slug, service_pct, vat_pct, floor_discount_max_pct) VALUES ($1,'کافه‌رستوران نارنج','narenj',10,10,10)`, [narenj]);
    const saadat = randomUUID();
    const vanak = randomUUID();
    await c.query(`INSERT INTO branches (id, restaurant_id, name, address) VALUES ($1,$2,'نارنج سعادت‌آباد','سعادت‌آباد، میدان کاج، خیابان سرو غربی'), ($3,$2,'نارنج ونک','ونک، خیابان ونک‌پارک، پلاک ۱۸')`, [saadat, narenj, vanak]);
    const user = async (restaurant: string, branch: string | null, username: string, name: string, role: string): Promise<Staff> => {
      const id = randomUUID();
      await c.query('INSERT INTO users (id, restaurant_id, branch_id, username, display_name, role, password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, restaurant, branch, username, name, role, pw]);
      return { id, name, role, branch: branch ?? '' };
    };
    const sara = await user(narenj, null, 'sara', 'سارا نیک‌نام', 'manager');
    const ali = await user(narenj, saadat, 'ali', 'علی رضایی', 'floor');
    const maryam = await user(narenj, saadat, 'maryam', 'مریم کاظمی', 'floor');
    const reza = await user(narenj, saadat, 'reza', 'استاد رضا', 'kitchen');
    const kaveh = await user(narenj, vanak, 'kaveh', 'کاوه صادقی', 'floor');
    const sahar = await user(narenj, vanak, 'sahar', 'سحر امینی', 'floor');
    const nima = await user(narenj, vanak, 'nima', 'نیما حاتمی', 'kitchen');

    const mkTables = async (restaurant: string, branch: string, zones: [string, number, number, number][]) => {
      const out: { id: string }[] = [];
      let n = 1;
      for (const [zone, count, seats, sortBase] of zones) {
        for (let i = 0; i < count; i++) {
          const id = randomUUID();
          await c.query('INSERT INTO dining_tables (id, restaurant_id, branch_id, label, zone, seats, sort) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, restaurant, branch, String(n), zone, i % 3 === 2 ? seats + 2 : seats, sortBase + n]);
          out.push({ id }); n++;
        }
      }
      return out;
    };
    const tSaadat = await mkTables(narenj, saadat, [['سالن اصلی', 12, 4, 0], ['تراس', 6, 4, 100], ['اتاق خصوصی', 2, 8, 200]]);
    const tVanak = await mkTables(narenj, vanak, [['سالن', 10, 4, 0], ['بام', 6, 4, 100]]);
    const menu = await createMenu(c, narenj, NARENJ_MENU, ['ته‌چین مرغ']);

    const common = { restaurantId: narenj, menu, servicePct: 10, vatPct: 10, days: 30, today, nowMs };
    const planS: Plan = { ...common, branchId: saadat, tables: tSaadat, staff: [sara, ali, maryam, reza], scale: 1 };
    const planV: Plan = { ...common, branchId: vanak, tables: tVanak, staff: [sara, kaveh, sahar, nima], scale: 0.7 };
    for (const [plan, live] of [[planS, 'S'], [planV, 'V']] as const) {
      const h = buildHistory(plan);
      await insertOrders(c, h.orders, h.items, h.pays, h.audits, false);
      let seq = h.seq;
      const spec = live === 'S'
        ? [
            { tableIdx: 0, minutesAgo: 52, bill: true, lines: [['چلوکباب کوبیده (۲ سیخ)', 2, 46], ['قورمه‌سبزی', 1, 46], ['دوغ محلی', 3, 46], ['سالاد شیرازی', 1, 50], ['تیرامیسو', 2, 12]] },
            { tableIdx: 2, minutesAgo: 34, lines: [['برگر ذغالی', 2, 26], ['سیب‌زمینی سرخ‌کرده', 1, 28], ['موهیتو', 2, 28], ['نوشابه', 1, 28]] },
            { tableIdx: 5, minutesAgo: 21, lines: [['زرشک‌پلو با مرغ', 2, 14], ['جوجه‌کباب با استخوان', 1, 14], ['لیموناد', 2, 14]] },
            { tableIdx: 8, minutesAgo: 9, lines: [['پیتزا مخصوص (۳۰ سانتی)', 1, 7], ['پاستا آلفردو', 1, 7], ['آیس‌لاته', 2, 7]] },
            { tableIdx: 13, minutesAgo: 17, lines: [['لاته', 2, 15], ['کاپوچینو', 1, 15], ['چیزکیک', 2, 15], ['کیک شکلاتی', 1, 15]] },
            { tableIdx: 18, minutesAgo: 3, lines: [['چلوکباب برگ', 3, 2], ['باقالی‌پلو با ماهیچه', 1, 2], ['دوغ محلی', 4, 2], ['زیتون پرورده', 1, 2]] },
          ] as const
        : [
            { tableIdx: 1, minutesAgo: 25, lines: [['چنجه گوشت', 2, 19], ['قیمه', 1, 19], ['دوغ محلی', 3, 19]] },
            { tableIdx: 4, minutesAgo: 12, lines: [['برگر ذغالی', 1, 8], ['آمریکانو', 1, 8], ['تیرامیسو', 1, 3]] },
            { tableIdx: 11, minutesAgo: 5, lines: [['موکا', 2, 4], ['کیک شکلاتی', 2, 4]] },
          ] as const;
      const takeaway = live === 'S'
        ? [{ minutesAgo: 6, lines: [['چلوکباب کوبیده (۲ سیخ)', 3, 5], ['دوغ محلی', 3, 5]] as [string, number, number][] }]
        : [];
      const lv = buildLive(plan, seq, spec.map((s) => ({ ...s, lines: s.lines as unknown as [string, number, number][] })), takeaway);
      await insertOrders(c, lv.orders, lv.items, [], [], true);
      seq = lv.seq;
      await c.query('UPDATE branches SET order_seq = $2 WHERE id = $1', [plan.branchId, seq]);
    }

    // ---------------- Restaurant 2: a tea house, to prove tenants never mix ----------------
    const bagh = randomUUID();
    await c.query(`INSERT INTO restaurants (id, name, slug, service_pct, vat_pct, floor_discount_max_pct) VALUES ($1,'چای‌خانه سنتی باغ','bagh',0,10,5)`, [bagh]);
    const baghBranch = randomUUID();
    await c.query(`INSERT INTO branches (id, restaurant_id, name, address) VALUES ($1,$2,'چای‌خانه باغ','اصفهان، خیابان چهارباغ بالا')`, [baghBranch, bagh]);
    const bMgr = await user(bagh, null, 'bagh', 'یاسر باغبان', 'manager');
    const bFloor = await user(bagh, baghBranch, 'golnar', 'گلنار موسوی', 'floor');
    const bKitchen = await user(bagh, baghBranch, 'davood', 'داوود', 'kitchen');
    const tBagh = await mkTables(bagh, baghBranch, [['حیاط', 6, 4, 0], ['شاه‌نشین', 3, 6, 100]]);
    const bMenu = await createMenu(c, bagh, BAGH_MENU, []);
    const planB: Plan = { restaurantId: bagh, branchId: baghBranch, tables: tBagh, menu: bMenu, staff: [bMgr, bFloor, bKitchen], servicePct: 0, vatPct: 10, scale: 0.55, days: 14, today, nowMs };
    const hb = buildHistory(planB);
    await insertOrders(c, hb.orders, hb.items, hb.pays, hb.audits, false);
    const lvb = buildLive(planB, hb.seq, [{ tableIdx: 0, minutesAgo: 14, lines: [['چای ذغالی', 4, 12], ['آبگوشت سنگی', 2, 12], ['باقلوا', 1, 4]] }], []);
    await insertOrders(c, lvb.orders, lvb.items, [], [], true);
    await c.query('UPDATE branches SET order_seq = $2 WHERE id = $1', [baghBranch, lvb.seq]);

    await c.query('COMMIT');
    const counts = (await c.query(`SELECT (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM order_items) AS items, (SELECT count(*) FROM payments) AS payments`)).rows[0];
    console.log('seed ok', counts);
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_ADMIN_URL;
  const pw = process.env.APP_DB_PASSWORD;
  if (!url || !pw) { console.error('DATABASE_ADMIN_URL and APP_DB_PASSWORD are required'); process.exit(1); }
  seed(url, pw, { reset: process.argv.includes('--reset') }).catch((e) => { console.error(e); process.exit(1); });
}
