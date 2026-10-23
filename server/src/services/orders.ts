/**
 * Docs:
 * - Feature: /docs/features/ordering-and-checkout.md
 * - Concurrency: /docs/architecture/concurrency.md
 */
import type { Tx } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { computeTotals, type Totals } from '../lib/money.js';

export interface AuthUser {
  id: string;
  restaurantId: string;
  branchId: string | null;
  role: 'manager' | 'floor' | 'kitchen';
  name: string;
}

export type ItemStatus = 'new' | 'preparing' | 'ready' | 'served' | 'void';

export function assertBranch(user: AuthUser, branchId: string) {
  if (user.branchId && user.branchId !== branchId) throw forbidden('این شعبه برای شما نیست');
}

const ORDER_COLS = `o.id, o.branch_id, o.table_id, o.kind, o.number, o.status, o.guests, o.opened_at, o.closed_at,
  o.bill_requested_at, o.discount_kind, o.discount_value, o.discount_reason, o.version,
  o.paid_subtotal, o.paid_discount, o.paid_service, o.paid_vat, o.paid_total`;

/** Full order snapshot as the UI consumes it. Totals are always server-computed. */
export async function loadOrder(tx: Tx, orderId: string, lock: 'none' | 'update' = 'none') {
  const o = (
    await tx.query(
      `SELECT ${ORDER_COLS}, t.label AS table_label, t.zone AS table_zone, u.display_name AS opened_by_name,
              r.service_pct, r.vat_pct, r.floor_discount_max_pct
         FROM orders o
         JOIN restaurants r ON r.id = o.restaurant_id
         LEFT JOIN dining_tables t ON t.id = o.table_id
         JOIN users u ON u.id = o.opened_by
        WHERE o.id = $1 ${lock === 'update' ? 'FOR UPDATE OF o' : ''}`,
      [orderId],
    )
  ).rows[0];
  if (!o) throw notFound('سفارش پیدا نشد');
  const items = (
    await tx.query(
      `SELECT id, menu_item_id, name, unit_price, station, qty, note, status, version, round,
              created_at, status_at, ready_at, void_reason, void_stage
         FROM order_items WHERE order_id = $1 ORDER BY created_at, line_no`,
      [orderId],
    )
  ).rows;
  const payments = (
    await tx.query(
      `SELECT p.id, p.method, p.amount, p.created_at, u.display_name AS by_name
         FROM payments p JOIN users u ON u.id = p.created_by WHERE p.order_id = $1 ORDER BY p.created_at`,
      [orderId],
    )
  ).rows;
  const subtotal = items.filter((i) => i.status !== 'void').reduce((s, i) => s + i.qty * i.unit_price, 0);
  const totals: Totals =
    o.status === 'paid'
      ? { subtotal: o.paid_subtotal, discount: o.paid_discount, service: o.paid_service, vat: o.paid_vat, total: o.paid_total }
      : computeTotals(subtotal, { kind: o.discount_kind, value: o.discount_value }, o.service_pct, o.vat_pct);
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  return {
    id: o.id,
    branchId: o.branch_id,
    tableId: o.table_id,
    tableLabel: o.table_label,
    tableZone: o.table_zone,
    kind: o.kind,
    number: o.number,
    status: o.status,
    guests: o.guests,
    openedAt: o.opened_at,
    closedAt: o.closed_at,
    openedByName: o.opened_by_name,
    billRequestedAt: o.bill_requested_at,
    discount: o.discount_kind ? { kind: o.discount_kind, value: o.discount_value, reason: o.discount_reason } : null,
    version: o.version,
    floorDiscountMaxPct: o.floor_discount_max_pct,
    items: items.map((i) => ({
      id: i.id,
      menuItemId: i.menu_item_id,
      name: i.name,
      unitPrice: i.unit_price,
      station: i.station,
      qty: i.qty,
      note: i.note,
      status: i.status,
      version: i.version,
      round: i.round,
      createdAt: i.created_at,
      statusAt: i.status_at,
      voidReason: i.void_reason,
    })),
    payments: payments.map((p) => ({ id: p.id, method: p.method, amount: p.amount, createdAt: p.created_at, byName: p.by_name })),
    totals,
    paidAmount: paid,
    remaining: Math.max(0, totals.total - paid),
  };
}
export type OrderView = Awaited<ReturnType<typeof loadOrder>>;

async function audit(
  tx: Tx,
  user: AuthUser,
  branchId: string | null,
  action: string,
  entity: string,
  entityId: string,
  data: Record<string, unknown>,
) {
  await tx.query(
    `INSERT INTO audit_log (restaurant_id, branch_id, actor_id, action, entity, entity_id, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [user.restaurantId, branchId, user.id, action, entity, entityId, JSON.stringify(data)],
  );
}

/** Lock the order row and check it still accepts changes. */
async function lockOpenOrder(tx: Tx, user: AuthUser, orderId: string) {
  const r = (await tx.query('SELECT id, branch_id, status, kind, version FROM orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
  if (!r) throw notFound('سفارش پیدا نشد');
  assertBranch(user, r.branch_id);
  if (r.status !== 'open') {
    throw conflict('order_closed', 'این سفارش دیگر باز نیست', await loadOrder(tx, orderId));
  }
  return r as { id: string; branch_id: string; status: string; kind: string; version: number };
}

export async function openOrder(
  tx: Tx,
  user: AuthUser,
  input: { branchId: string; tableId: string | null; kind: 'dine_in' | 'takeaway'; guests: number },
) {
  assertBranch(user, input.branchId);
  if (input.kind === 'dine_in') {
    if (!input.tableId) throw badRequest('میز مشخص نشده است');
    const t = (await tx.query('SELECT branch_id, active FROM dining_tables WHERE id = $1', [input.tableId])).rows[0];
    if (!t || t.branch_id !== input.branchId || !t.active) throw notFound('میز پیدا نشد');
    const existing = (await tx.query(`SELECT id FROM orders WHERE table_id = $1 AND status = 'open'`, [input.tableId])).rows[0];
    if (existing) return { order: await loadOrder(tx, existing.id), created: false };
  } else if (input.tableId) {
    throw badRequest('سفارش بیرون‌بر میز ندارد');
  }
  const number = (await tx.query('UPDATE branches SET order_seq = order_seq + 1 WHERE id = $1 RETURNING order_seq', [input.branchId])).rows[0]
    ?.order_seq;
  if (!number) throw notFound('شعبه پیدا نشد');
  // The partial unique index makes a simultaneous open of the same table safe: the loser gets the winner's order.
  const ins = await tx.query(
    `INSERT INTO orders (restaurant_id, branch_id, table_id, kind, number, guests, opened_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
    [user.restaurantId, input.branchId, input.tableId, input.kind, number, input.guests, user.id],
  );
  if (ins.rowCount === 0) {
    const w = (await tx.query(`SELECT id FROM orders WHERE table_id = $1 AND status = 'open'`, [input.tableId])).rows[0];
    return { order: await loadOrder(tx, w.id), created: false };
  }
  return { order: await loadOrder(tx, ins.rows[0].id), created: true };
}

export async function addItems(
  tx: Tx,
  user: AuthUser,
  orderId: string,
  requestId: string,
  lines: { menuItemId: string; qty: number; note?: string | null }[],
) {
  const o = await lockOpenOrder(tx, user, orderId);
  // Retried request (flaky Wi-Fi): same batch id means we already stored it.
  const dup = await tx.query('SELECT 1 FROM order_items WHERE order_id = $1 AND client_request_id = $2 LIMIT 1', [orderId, requestId]);
  if (dup.rowCount) return loadOrder(tx, orderId);

  const ids = [...new Set(lines.map((l) => l.menuItemId))];
  const menu = (await tx.query('SELECT id, name, price, station, available FROM menu_items WHERE id = ANY($1::uuid[])', [ids])).rows;
  const byId = new Map(menu.map((m) => [m.id, m]));
  if (byId.size !== ids.length) throw badRequest('یکی از آیتم‌ها در منو نیست');
  const unavailable = ids.map((id) => byId.get(id)).filter((m) => !m.available);
  if (unavailable.length) {
    throw conflict('item_unavailable', `تمام شده: ${unavailable.map((m) => m.name).join('، ')}`, {
      unavailableIds: unavailable.map((m) => m.id),
    });
  }
  const round = (await tx.query('SELECT coalesce(max(round), 0) + 1 AS r FROM order_items WHERE order_id = $1', [orderId])).rows[0].r;
  let n = 0;
  for (const l of lines) {
    const m = byId.get(l.menuItemId);
    await tx.query(
      `INSERT INTO order_items (restaurant_id, order_id, menu_item_id, name, unit_price, station, qty, note, round, client_request_id, line_no, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [user.restaurantId, orderId, m.id, m.name, m.price, m.station, l.qty, l.note?.trim() || null, round, requestId, n++, user.id],
    );
  }
  await tx.query('UPDATE orders SET version = version + 1, bill_requested_at = NULL WHERE id = $1', [orderId]);
  return loadOrder(tx, orderId);
}

const FORWARD: Record<string, ItemStatus[]> = {
  new: ['preparing', 'ready'],
  preparing: ['ready', 'new'],
  ready: ['served', 'preparing'],
  served: [],
};
const KITCHEN_TARGETS: ItemStatus[] = ['new', 'preparing', 'ready'];

export async function setItemStatus(tx: Tx, user: AuthUser, itemId: string, to: ItemStatus, version: number) {
  const cur = (
    await tx.query(
      `SELECT i.id, i.order_id, i.status, i.version, o.branch_id
         FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.id = $1`,
      [itemId],
    )
  ).rows[0];
  if (!cur) throw notFound('آیتم پیدا نشد');
  assertBranch(user, cur.branch_id);
  if (user.role === 'kitchen' && !KITCHEN_TARGETS.includes(to)) throw forbidden('آشپزخانه فقط وضعیت تهیه را تغییر می‌دهد');
  if (user.role === 'floor' && to !== 'served') throw forbidden('سالن فقط می‌تواند «سرو شد» بزند');
  if (to === 'void') throw badRequest('برای لغو از مسیر لغو استفاده کنید');
  // Compare-and-set on version AND legal source states: a stale tap cannot overwrite a newer decision.
  const upd = await tx.query(
    `UPDATE order_items SET status = $2::item_status, version = version + 1, status_at = now(),
            ready_at = CASE WHEN $2::item_status = 'ready' THEN now()
                            WHEN $2::item_status IN ('new','preparing') THEN NULL ELSE ready_at END
      WHERE id = $1 AND version = $3 AND status = ANY($4::item_status[])
      RETURNING id`,
    [itemId, to, version, allowedFrom(to)],
  );
  const view = () => loadOrder(tx, cur.order_id);
  if (upd.rowCount === 0) {
    const fresh = (await view()).items.find((i) => i.id === itemId)!;
    if (fresh.status === to) return { order: await view(), changed: false }; // someone already did exactly this
    throw conflict('item_changed', 'وضعیت این آیتم همزمان تغییر کرد', { item: fresh });
  }
  return { order: await view(), changed: true, orderId: cur.order_id, branchId: cur.branch_id };
}

// States from which `to` may be reached. Enforced in SQL via the version CAS plus this status filter.
function allowedFrom(to: ItemStatus): ItemStatus[] {
  return (Object.keys(FORWARD) as ItemStatus[]).filter((from) => FORWARD[from].includes(to));
}

export async function voidItem(tx: Tx, user: AuthUser, itemId: string, reason: string | null, version: number) {
  const cur = (
    await tx.query(
      `SELECT i.id, i.order_id, i.status, i.version, i.name, i.qty, i.unit_price, o.branch_id, o.status AS order_status
         FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.id = $1`,
      [itemId],
    )
  ).rows[0];
  if (!cur) throw notFound('آیتم پیدا نشد');
  assertBranch(user, cur.branch_id);
  if (user.role === 'kitchen') throw forbidden('آشپزخانه نمی‌تواند آیتم را لغو کند');
  // Lock order first (same order as every other bill-changing path) to avoid lock-order deadlocks.
  await lockOpenOrder(tx, user, cur.order_id);
  const stage = (await tx.query('SELECT status, version FROM order_items WHERE id = $1 FOR UPDATE', [itemId])).rows[0];
  if (stage.version !== version || stage.status === 'void') {
    const fresh = (await loadOrder(tx, cur.order_id)).items.find((i) => i.id === itemId);
    if (stage.status === 'void') return { order: await loadOrder(tx, cur.order_id), orderId: cur.order_id, branchId: cur.branch_id };
    throw conflict('item_changed', 'وضعیت این آیتم همزمان تغییر کرد', { item: fresh });
  }
  // Floor staff may only cancel what the kitchen has not touched yet. Anything later is the manager's call.
  if (user.role === 'floor' && stage.status !== 'new') {
    throw forbidden('بعد از شروع تهیه فقط مدیر می‌تواند لغو کند');
  }
  const why = (reason ?? '').trim();
  if (stage.status !== 'new' && why.length < 2) throw badRequest('دلیل لغو را بنویسید');
  await tx.query(
    `UPDATE order_items SET status = 'void', version = version + 1, status_at = now(),
            void_stage = $2, void_reason = $3, voided_by = $4 WHERE id = $1`,
    [itemId, stage.status, why || 'اشتباه ثبت شد', user.id],
  );
  await tx.query('UPDATE orders SET version = version + 1 WHERE id = $1', [cur.order_id]);
  await audit(tx, user, cur.branch_id, 'item.void', 'order_item', itemId, {
    name: cur.name,
    qty: cur.qty,
    value: cur.qty * cur.unit_price,
    stage: stage.status,
    reason: why,
  });
  return { order: await loadOrder(tx, cur.order_id), orderId: cur.order_id, branchId: cur.branch_id };
}

export async function setDiscount(
  tx: Tx,
  user: AuthUser,
  orderId: string,
  input: { kind: 'percent' | 'amount' | null; value: number; reason: string | null; version: number },
) {
  const o = await lockOpenOrder(tx, user, orderId);
  if (user.role === 'kitchen') throw forbidden();
  if (o.version !== input.version) {
    throw conflict('bill_changed', 'صورتحساب همزمان تغییر کرد', await loadOrder(tx, orderId));
  }
  const cur = await loadOrder(tx, orderId);
  if (input.kind) {
    if ((input.reason ?? '').trim().length < 2) throw badRequest('دلیل تخفیف را بنویسید');
    const effectivePct =
      input.kind === 'percent' ? input.value : cur.totals.subtotal === 0 ? 0 : (input.value / cur.totals.subtotal) * 100;
    if (input.kind === 'percent' && input.value > 100) throw badRequest('درصد تخفیف نامعتبر است');
    if (user.role === 'floor' && effectivePct > cur.floorDiscountMaxPct) {
      throw forbidden(`سقف تخفیف شما ${cur.floorDiscountMaxPct}٪ است. برای بیشتر، از مدیر بخواهید`);
    }
  }
  await tx.query(
    `UPDATE orders SET discount_kind = $2, discount_value = $3, discount_reason = $4, discount_by = $5, version = version + 1
      WHERE id = $1`,
    [orderId, input.kind, input.kind ? input.value : 0, input.kind ? input.reason!.trim() : null, input.kind ? user.id : null],
  );
  const next = await loadOrder(tx, orderId);
  await audit(tx, user, o.branch_id, input.kind ? 'discount.set' : 'discount.clear', 'order', orderId, {
    kind: input.kind,
    value: input.value,
    amount: next.totals.discount,
    subtotal: next.totals.subtotal,
    reason: input.reason,
  });
  return next;
}

export async function requestBill(tx: Tx, user: AuthUser, orderId: string) {
  const o = await lockOpenOrder(tx, user, orderId);
  if (user.role === 'kitchen') throw forbidden();
  await tx.query('UPDATE orders SET bill_requested_at = coalesce(bill_requested_at, now()) WHERE id = $1', [orderId]);
  return { order: await loadOrder(tx, orderId), branchId: o.branch_id };
}

export async function pay(
  tx: Tx,
  user: AuthUser,
  orderId: string,
  input: { method: 'cash' | 'card' | 'transfer'; amount: number; orderVersion: number; idempotencyKey: string },
) {
  if (user.role === 'kitchen') throw forbidden();
  const head = (await tx.query('SELECT branch_id FROM orders WHERE id = $1', [orderId])).rows[0];
  if (!head) throw notFound('سفارش پیدا نشد');
  assertBranch(user, head.branch_id);

  // Exclusive lock: payment and "add item" cannot interleave on one order.
  const o = (await tx.query('SELECT status, version, kind, restaurant_id FROM orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
  const retry = await tx.query('SELECT 1 FROM payments WHERE order_id = $1 AND idempotency_key = $2', [orderId, input.idempotencyKey]);
  if (retry.rowCount) return { order: await loadOrder(tx, orderId), branchId: head.branch_id }; // replay of a request we already applied
  if (o.status !== 'open') throw conflict('order_closed', 'این سفارش دیگر باز نیست', await loadOrder(tx, orderId));
  if (o.version !== input.orderVersion) {
    throw conflict('bill_changed', 'صورتحساب تغییر کرد. مبلغ جدید را ببینید و دوباره تأیید کنید', await loadOrder(tx, orderId));
  }
  const cur = await loadOrder(tx, orderId);
  if (cur.totals.total === 0) throw badRequest('سفارش خالی است');
  if (input.amount > cur.remaining) throw badRequest(`مبلغ بیشتر از مانده حساب است (${cur.remaining})`);

  await tx.query(
    `INSERT INTO payments (restaurant_id, order_id, method, amount, created_by, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)`,
    [user.restaurantId, orderId, input.method, input.amount, user.id, input.idempotencyKey],
  );

  if (input.amount === cur.remaining) {
    const pending = cur.items.filter((i) => i.status === 'new' || i.status === 'preparing').length;
    if (pending && cur.kind === 'dine_in') {
      throw conflict('items_pending', `${pending} آیتم هنوز آماده نشده است`, cur); // rolls the payment back too
    }
    await tx.query(`UPDATE order_items SET status = 'served', version = version + 1, status_at = now() WHERE order_id = $1 AND status = 'ready' AND $2::text = 'dine_in'`, [
      orderId,
      cur.kind,
    ]);
    await tx.query(
      `UPDATE orders SET status = 'paid', closed_at = now(), paid_subtotal = $2, paid_discount = $3, paid_service = $4,
              paid_vat = $5, paid_total = $6, version = version + 1 WHERE id = $1`,
      [orderId, cur.totals.subtotal, cur.totals.discount, cur.totals.service, cur.totals.vat, cur.totals.total],
    );
  }
  return { order: await loadOrder(tx, orderId), branchId: head.branch_id };
}

export async function voidOrder(tx: Tx, user: AuthUser, orderId: string, reason: string) {
  if (user.role !== 'manager') throw forbidden('فقط مدیر می‌تواند سفارش را ابطال کند');
  const o = await lockOpenOrder(tx, user, orderId);
  const hasPay = await tx.query('SELECT 1 FROM payments WHERE order_id = $1 LIMIT 1', [orderId]);
  if (hasPay.rowCount) throw conflict('has_payments', 'برای سفارشی که پرداخت دارد ابطال ممکن نیست');
  await tx.query(`UPDATE order_items SET status = 'void', void_stage = status, void_reason = $2, voided_by = $3, status_at = now(), version = version + 1
                   WHERE order_id = $1 AND status <> 'void'`, [orderId, reason, user.id]);
  await tx.query(`UPDATE orders SET status = 'void', closed_at = now(), version = version + 1 WHERE id = $1`, [orderId]);
  await audit(tx, user, o.branch_id, 'order.void', 'order', orderId, { reason });
  return { order: await loadOrder(tx, orderId), branchId: o.branch_id };
}
