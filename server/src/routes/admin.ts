/**
 * Docs:
 * - Feature: /docs/features/menu-and-floor-setup.md
 * - API: /docs/api/README.md
 * Manager-only setup: add menu items/categories, shape the floor (tables and zones).
 * Nothing here deletes: old orders point at tables and items, so "inactive" is the safe way to retire one.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { withTenant, type Tx } from '../db/pool.js';
import { bus } from '../lib/events.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { assertBranch, audit } from '../services/orders.js';

const MAX_TABLES_PER_BRANCH = 200;
const uuid = z.string().uuid();
const Id = z.object({ id: uuid });

/** Typed names: Arabic ي/ك become ی/ک, odd width forms fold, whitespace collapses. Keeps search and reports consistent. */
const normalizeFa = (s: string) => s.normalize('NFKC').replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/\s+/g, ' ').trim();
const text = (max: number) => z.string().transform(normalizeFa).pipe(z.string().min(1, 'خالی است').max(max, 'زیادی بلند است'));

const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === '23505';

const NewItem = z.object({
  categoryId: uuid,
  name: text(80),
  description: z.string().transform(normalizeFa).pipe(z.string().max(200)).nullish(),
  price: z.number().int().min(0).max(100_000_000),
  station: z.enum(['kitchen', 'bar']),
  prepMinutes: z.number().int().min(1).max(120).default(10),
});
const NewCategory = z.object({ name: text(60), icon: z.string().max(8).nullish() });
const NewTables = z.object({
  branchId: uuid,
  zone: text(40),
  seats: z.number().int().min(1).max(40),
  count: z.number().int().min(1).max(50).default(1),
  label: text(10).optional(), // only honoured for a single table; otherwise numbers continue automatically
});
const PatchTable = z
  .object({ label: text(10).optional(), zone: text(40).optional(), seats: z.number().int().min(1).max(40).optional(), active: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'چیزی برای تغییر نیست');
const RenameZone = z.object({ branchId: uuid, from: text(40), to: text(40) });

/** Where a new table in `zone` should sort. Existing zone: after its last table. New zone: the next hundred, so zones stay in blocks. */
async function nextSort(tx: Tx, branchId: string, zone: string): Promise<number> {
  const inZone = (await tx.query('SELECT max(sort) AS m FROM dining_tables WHERE branch_id = $1 AND zone = $2', [branchId, zone])).rows[0].m;
  if (inZone !== null) return inZone + 1;
  const any = (await tx.query('SELECT coalesce(max(sort), 0) AS m FROM dining_tables WHERE branch_id = $1', [branchId])).rows[0].m;
  return (Math.floor(any / 100) + 1) * 100;
}

const tableView = (r: any) => ({ id: r.id, label: r.label, zone: r.zone, seats: r.seats, sort: r.sort, active: r.active, busy: !!r.busy });

export function adminRoutes(app: FastifyInstance, { db, guard }: Ctx) {
  const manager = guard(['manager']);

  /* ---------------- menu ---------------- */

  app.post('/menu/items', { preHandler: manager }, async (req, reply) => {
    const b = NewItem.parse(req.body);
    const user = req.user!;
    const item = await withTenant(db, user.restaurantId, async (tx) => {
      // RLS makes a category of another restaurant invisible here: it is simply "not found".
      const cat = (await tx.query('SELECT id FROM menu_categories WHERE id = $1 FOR SHARE', [b.categoryId])).rows[0];
      if (!cat) throw notFound('دسته پیدا نشد');
      const sort = (await tx.query('SELECT coalesce(max(sort), -1) + 1 AS s FROM menu_items WHERE category_id = $1', [b.categoryId])).rows[0].s;
      let row;
      try {
        row = (
          await tx.query(
            `INSERT INTO menu_items (restaurant_id, category_id, name, description, price, station, prep_minutes, available, sort)
             VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)
             RETURNING id, category_id, name, description, price, station, prep_minutes, available`,
            [user.restaurantId, b.categoryId, b.name, b.description || null, b.price, b.station, b.prepMinutes, sort],
          )
        ).rows[0];
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('duplicate_name', `«${b.name}» از قبل در منو هست`);
        throw e;
      }
      await audit(tx, user, null, 'menu.create', 'menu_item', row.id, { name: b.name, price: b.price, station: b.station });
      return row;
    });
    bus.publish(user.restaurantId, { type: 'menu' });
    req.log.info({ menuItemId: item.id }, 'menu item created');
    return reply.status(201).send({
      item: { id: item.id, categoryId: item.category_id, name: item.name, description: item.description, price: item.price, station: item.station, prepMinutes: item.prep_minutes, available: item.available },
    });
  });

  app.post('/menu/categories', { preHandler: manager }, async (req, reply) => {
    const b = NewCategory.parse(req.body);
    const user = req.user!;
    const cat = await withTenant(db, user.restaurantId, async (tx) => {
      const sort = (await tx.query('SELECT coalesce(max(sort), -1) + 1 AS s FROM menu_categories')).rows[0].s;
      let row;
      try {
        row = (await tx.query('INSERT INTO menu_categories (restaurant_id, name, icon, sort) VALUES ($1,$2,$3,$4) RETURNING id, name, icon', [user.restaurantId, b.name, b.icon || null, sort])).rows[0];
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('duplicate_name', `دستهٔ «${b.name}» از قبل هست`);
        throw e;
      }
      await audit(tx, user, null, 'menu.category.create', 'menu_category', row.id, { name: b.name });
      return row;
    });
    bus.publish(user.restaurantId, { type: 'menu' });
    return reply.status(201).send({ category: { id: cat.id, name: cat.name, icon: cat.icon, items: [] } });
  });

  /* ---------------- floor: tables and zones ---------------- */

  const BranchQ = z.object({ branchId: uuid });
  app.get('/admin/tables', { preHandler: manager }, async (req) => {
    const { branchId } = BranchQ.parse(req.query);
    const user = req.user!;
    assertBranch(user, branchId);
    return withTenant(db, user.restaurantId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT t.id, t.label, t.zone, t.seats, t.sort, t.active,
                  EXISTS (SELECT 1 FROM orders o WHERE o.table_id = t.id AND o.status = 'open') AS busy
             FROM dining_tables t WHERE t.branch_id = $1 ORDER BY t.sort, t.label`,
          [branchId],
        )
      ).rows;
      return { tables: rows.map(tableView) };
    });
  });

  app.post('/admin/tables', { preHandler: manager }, async (req, reply) => {
    const b = NewTables.parse(req.body);
    const user = req.user!;
    assertBranch(user, b.branchId);
    const created = await withTenant(db, user.restaurantId, async (tx) => {
      // The branch row is the lock that serialises two managers numbering tables at the same moment.
      const br = (await tx.query('SELECT id FROM branches WHERE id = $1 FOR UPDATE', [b.branchId])).rows[0];
      if (!br) throw notFound('شعبه پیدا نشد');
      const existing = (await tx.query('SELECT count(*)::int AS n FROM dining_tables WHERE branch_id = $1', [b.branchId])).rows[0].n;
      if (existing + b.count > MAX_TABLES_PER_BRANCH) throw badRequest(`حداکثر ${MAX_TABLES_PER_BRANCH} میز در هر شعبه`);
      const maxNum = (await tx.query(`SELECT coalesce(max(label::int), 0) AS m FROM dining_tables WHERE branch_id = $1 AND label ~ '^[0-9]{1,6}$'`, [b.branchId])).rows[0].m;
      const labels = b.count === 1 && b.label ? [b.label] : Array.from({ length: b.count }, (_, i) => String(maxNum + i + 1));
      const sort0 = await nextSort(tx, b.branchId, b.zone);
      const rows = [];
      for (let i = 0; i < labels.length; i++) {
        try {
          rows.push(
            (
              await tx.query(
                `INSERT INTO dining_tables (restaurant_id, branch_id, label, zone, seats, sort) VALUES ($1,$2,$3,$4,$5,$6)
                 RETURNING id, label, zone, seats, sort, active, false AS busy`,
                [user.restaurantId, b.branchId, labels[i], b.zone, b.seats, sort0 + i],
              )
            ).rows[0],
          );
        } catch (e) {
          if (isUniqueViolation(e)) throw conflict('duplicate_label', `میز ${labels[i]} از قبل در این شعبه هست`);
          throw e;
        }
      }
      await audit(tx, user, b.branchId, 'table.create', 'branch', b.branchId, { zone: b.zone, seats: b.seats, labels });
      return rows;
    });
    bus.publish(user.restaurantId, { type: 'menu', branchId: b.branchId });
    return reply.status(201).send({ tables: created.map(tableView) });
  });

  app.patch('/admin/tables/:id', { preHandler: manager }, async (req) => {
    const { id } = Id.parse(req.params);
    const b = PatchTable.parse(req.body);
    const user = req.user!;
    const out = await withTenant(db, user.restaurantId, async (tx) => {
      const before = (await tx.query('SELECT id, branch_id, label, zone, seats, active FROM dining_tables WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound('میز پیدا نشد');
      assertBranch(user, before.branch_id);
      if (b.active === false && before.active) {
        const busy = await tx.query(`SELECT 1 FROM orders WHERE table_id = $1 AND status = 'open' LIMIT 1`, [id]);
        if (busy.rowCount) throw conflict('table_busy', 'این میز سفارش باز دارد. اول تسویه یا ابطال کنید');
      }
      const next = {
        label: b.label ?? before.label,
        zone: b.zone ?? before.zone,
        seats: b.seats ?? before.seats,
        active: b.active ?? before.active,
      };
      const sort = next.zone !== before.zone ? await nextSort(tx, before.branch_id, next.zone) : null;
      let row;
      try {
        row = (
          await tx.query(
            `UPDATE dining_tables SET label = $2, zone = $3, seats = $4, active = $5, sort = coalesce($6, sort) WHERE id = $1
             RETURNING id, label, zone, seats, sort, active, false AS busy`,
            [id, next.label, next.zone, next.seats, next.active, sort],
          )
        ).rows[0];
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('duplicate_label', `میز ${next.label} از قبل در این شعبه هست`);
        throw e;
      }
      await audit(tx, user, before.branch_id, before.active && next.active === false ? 'table.deactivate' : 'table.update', 'dining_table', id, {
        before: { label: before.label, zone: before.zone, seats: before.seats, active: before.active },
        after: next,
      });
      return { table: tableView(row), branchId: before.branch_id as string };
    });
    bus.publish(user.restaurantId, { type: 'menu', branchId: out.branchId });
    return { table: out.table };
  });

  // A zone exists only as the name its tables share, so renaming it is one bulk update (and merges if the name is taken).
  app.patch('/admin/zones', { preHandler: manager }, async (req) => {
    const b = RenameZone.parse(req.body);
    const user = req.user!;
    assertBranch(user, b.branchId);
    if (b.from === b.to) throw badRequest('نام جدید با نام قبلی یکی است');
    const moved = await withTenant(db, user.restaurantId, async (tx) => {
      const r = await tx.query('UPDATE dining_tables SET zone = $3 WHERE branch_id = $1 AND zone = $2', [b.branchId, b.from, b.to]);
      if (!r.rowCount) throw notFound('این بخش پیدا نشد');
      await audit(tx, user, b.branchId, 'zone.rename', 'branch', b.branchId, { from: b.from, to: b.to, tables: r.rowCount });
      return r.rowCount;
    });
    bus.publish(user.restaurantId, { type: 'menu', branchId: b.branchId });
    return { renamed: moved };
  });
}
