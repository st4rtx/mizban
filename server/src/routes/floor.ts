import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { withTenant } from '../db/pool.js';
import { bus } from '../lib/events.js';
import { badRequest, notFound } from '../lib/errors.js';
import { computeTotals } from '../lib/money.js';
import { assertBranch } from '../services/orders.js';

const BranchQ = z.object({ branchId: z.string().uuid() });

export function floorRoutes(app: FastifyInstance, { db, guard }: Ctx) {
  // Floor map: every table with the state of its open order, plus open takeaway tickets.
  app.get('/floor', { preHandler: guard(['manager', 'floor']) }, async (req) => {
    const { branchId } = BranchQ.parse(req.query);
    const user = req.user!;
    assertBranch(user, branchId);
    return withTenant(db, user.restaurantId, async (tx) => {
      const r = (await tx.query('SELECT service_pct, vat_pct FROM restaurants WHERE id = $1', [user.restaurantId])).rows[0];
      const tables = (
        await tx.query(
          `SELECT id, label, zone, seats FROM dining_tables WHERE branch_id = $1 AND active ORDER BY sort, label`,
          [branchId],
        )
      ).rows;
      const orders = (
        await tx.query(
          `SELECT o.id, o.table_id, o.kind, o.number, o.guests, o.opened_at, o.bill_requested_at, o.version,
                  o.discount_kind, o.discount_value,
                  coalesce(sum(i.qty * i.unit_price) FILTER (WHERE i.status <> 'void'), 0) AS subtotal,
                  count(*) FILTER (WHERE i.status = 'new')       AS n_new,
                  count(*) FILTER (WHERE i.status = 'preparing') AS n_preparing,
                  count(*) FILTER (WHERE i.status = 'ready')     AS n_ready,
                  count(*) FILTER (WHERE i.status = 'served')    AS n_served
             FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
            WHERE o.branch_id = $1 AND o.status = 'open'
            GROUP BY o.id`,
          [branchId],
        )
      ).rows;
      const view = (o: (typeof orders)[number]) => ({
        id: o.id,
        number: o.number,
        guests: o.guests,
        openedAt: o.opened_at,
        billRequestedAt: o.bill_requested_at,
        counts: { new: o.n_new, preparing: o.n_preparing, ready: o.n_ready, served: o.n_served },
        total: computeTotals(o.subtotal, { kind: o.discount_kind, value: o.discount_value }, r.service_pct, r.vat_pct).total,
      });
      const byTable = new Map(orders.filter((o) => o.table_id).map((o) => [o.table_id, o]));
      return {
        tables: tables.map((t) => ({ ...t, order: byTable.has(t.id) ? view(byTable.get(t.id)!) : null })),
        takeaway: orders.filter((o) => o.kind === 'takeaway').map(view),
      };
    });
  });

  // Menu for ordering. Kitchen sees it too (read-only) so it can show names; availability is server-checked on add.
  app.get('/menu', { preHandler: guard() }, async (req) => {
    const user = req.user!;
    return withTenant(db, user.restaurantId, async (tx) => {
      const cats = (await tx.query('SELECT id, name, icon FROM menu_categories ORDER BY sort')).rows;
      const items = (
        await tx.query('SELECT id, category_id, name, description, price, station, prep_minutes, available FROM menu_items ORDER BY sort, name')
      ).rows;
      return {
        categories: cats.map((c) => ({
          ...c,
          items: items
            .filter((i) => i.category_id === c.id)
            .map((i) => ({ id: i.id, name: i.name, description: i.description, price: i.price, station: i.station, prepMinutes: i.prep_minutes, available: i.available })),
        })),
      };
    });
  });

  // Manager: mark sold out / change price. Price edits never touch existing order lines (they hold a snapshot).
  const Patch = z.object({ available: z.boolean().optional(), price: z.number().int().min(0).max(100_000_000).optional() }).refine((v) => v.available !== undefined || v.price !== undefined, 'چیزی برای تغییر نیست');
  app.patch('/menu/items/:id', { preHandler: guard(['manager']) }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = Patch.parse(req.body);
    const user = req.user!;
    const out = await withTenant(db, user.restaurantId, async (tx) => {
      const before = (await tx.query('SELECT price, available, name FROM menu_items WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound('آیتم پیدا نشد');
      const after = { price: body.price ?? before.price, available: body.available ?? before.available };
      await tx.query('UPDATE menu_items SET price = $2, available = $3 WHERE id = $1', [id, after.price, after.available]);
      await tx.query(
        `INSERT INTO audit_log (restaurant_id, actor_id, action, entity, entity_id, data) VALUES ($1,$2,$3,'menu_item',$4,$5)`,
        [user.restaurantId, user.id, body.price !== undefined && body.price !== before.price ? 'menu.price' : 'menu.availability', id, JSON.stringify({ name: before.name, before, after })],
      );
      return after;
    });
    bus.publish(user.restaurantId, { type: 'menu' });
    return out;
  });
}
