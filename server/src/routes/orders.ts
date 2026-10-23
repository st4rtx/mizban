import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { withTenant } from '../db/pool.js';
import { bus } from '../lib/events.js';
import {
  addItems,
  assertBranch,
  loadOrder,
  openOrder,
  pay,
  requestBill,
  setDiscount,
  setItemStatus,
  voidItem,
  voidOrder,
} from '../services/orders.js';

const Id = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();

export function orderRoutes(app: FastifyInstance, { db, guard }: Ctx) {
  const staff = guard(['manager', 'floor']);

  const emit = (restaurantId: string, branchId: string, orderId: string, tableId?: string | null) =>
    bus.publish(restaurantId, { type: 'order', orderId, branchId, tableId });

  app.post('/orders', { preHandler: staff }, async (req, reply) => {
    const body = z
      .object({ branchId: uuid, tableId: uuid.nullable().default(null), kind: z.enum(['dine_in', 'takeaway']), guests: z.number().int().min(1).max(40).default(1) })
      .parse(req.body);
    const user = req.user!;
    const { order, created } = await withTenant(db, user.restaurantId, (tx) => openOrder(tx, user, body));
    if (created) emit(user.restaurantId, order.branchId, order.id, order.tableId);
    return reply.status(created ? 201 : 200).send({ order, created });
  });

  // Kitchen may read orders it can see on its board (needed for ticket detail); everyone is branch-scoped.
  app.get('/orders/:id', { preHandler: guard() }, async (req) => {
    const { id } = Id.parse(req.params);
    const user = req.user!;
    return withTenant(db, user.restaurantId, async (tx) => {
      const order = await loadOrder(tx, id);
      assertBranch(user, order.branchId);
      return { order };
    });
  });

  app.post('/orders/:id/items', { preHandler: staff }, async (req) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({
        requestId: uuid,
        items: z.array(z.object({ menuItemId: uuid, qty: z.number().int().min(1).max(99), note: z.string().max(120).nullish() })).min(1).max(40),
      })
      .parse(req.body);
    const user = req.user!;
    const order = await withTenant(db, user.restaurantId, (tx) => addItems(tx, user, id, body.requestId, body.items));
    emit(user.restaurantId, order.branchId, order.id, order.tableId);
    return { order };
  });

  app.patch('/order-items/:id/status', { preHandler: guard() }, async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ to: z.enum(['new', 'preparing', 'ready', 'served']), version: z.number().int() }).parse(req.body);
    const user = req.user!;
    const r = await withTenant(db, user.restaurantId, (tx) => setItemStatus(tx, user, id, body.to, body.version));
    if (r.changed) emit(user.restaurantId, r.branchId!, r.orderId!, r.order.tableId);
    return { order: r.order };
  });

  app.post('/order-items/:id/void', { preHandler: staff }, async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ reason: z.string().max(200).nullish(), version: z.number().int() }).parse(req.body);
    const user = req.user!;
    const r = await withTenant(db, user.restaurantId, (tx) => voidItem(tx, user, id, body.reason ?? null, body.version));
    emit(user.restaurantId, r.branchId, r.orderId, r.order.tableId);
    return { order: r.order };
  });

  app.put('/orders/:id/discount', { preHandler: staff }, async (req) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({ kind: z.enum(['percent', 'amount']).nullable(), value: z.number().int().min(0).max(1_000_000_000).default(0), reason: z.string().max(200).nullish(), version: z.number().int() })
      .parse(req.body);
    const user = req.user!;
    const order = await withTenant(db, user.restaurantId, (tx) => setDiscount(tx, user, id, { ...body, reason: body.reason ?? null }));
    emit(user.restaurantId, order.branchId, order.id, order.tableId);
    return { order };
  });

  app.post('/orders/:id/bill-request', { preHandler: staff }, async (req) => {
    const { id } = Id.parse(req.params);
    const user = req.user!;
    const r = await withTenant(db, user.restaurantId, (tx) => requestBill(tx, user, id));
    emit(user.restaurantId, r.branchId, id, r.order.tableId);
    return { order: r.order };
  });

  app.post('/orders/:id/payments', { preHandler: staff }, async (req) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({ method: z.enum(['cash', 'card', 'transfer']), amount: z.number().int().min(1).max(1_000_000_000), orderVersion: z.number().int(), idempotencyKey: uuid })
      .parse(req.body);
    const user = req.user!;
    const r = await withTenant(db, user.restaurantId, (tx) => pay(tx, user, id, body));
    emit(user.restaurantId, r.branchId, id, r.order.tableId);
    req.log.info({ orderId: id, method: body.method, amount: body.amount, status: r.order.status }, 'payment recorded');
    return { order: r.order };
  });

  app.post('/orders/:id/void', { preHandler: guard(['manager']) }, async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ reason: z.string().min(2).max(200) }).parse(req.body);
    const user = req.user!;
    const r = await withTenant(db, user.restaurantId, (tx) => voidOrder(tx, user, id, body.reason));
    emit(user.restaurantId, r.branchId, id, r.order.tableId);
    req.log.warn({ orderId: id, reason: body.reason }, 'order voided');
    return { order: r.order };
  });
}
