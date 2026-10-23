import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { withTenant } from '../db/pool.js';
import { assertBranch } from '../services/orders.js';

export function kitchenRoutes(app: FastifyInstance, { db, guard }: Ctx) {
  // Everything the kitchen/bar still has to cook or hand over, oldest first. Paid takeaway orders stay until handed over.
  app.get('/kitchen', { preHandler: guard(['manager', 'kitchen']) }, async (req) => {
    const q = z.object({ branchId: z.string().uuid(), station: z.enum(['kitchen', 'bar']).optional() }).parse(req.query);
    const user = req.user!;
    assertBranch(user, q.branchId);
    return withTenant(db, user.restaurantId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT i.id, i.order_id, i.name, i.qty, i.note, i.status, i.version, i.station, i.round, i.created_at, i.status_at,
                  o.number, o.kind, t.label AS table_label, t.zone AS table_zone
             FROM order_items i
             JOIN orders o ON o.id = i.order_id
             LEFT JOIN dining_tables t ON t.id = o.table_id
            WHERE o.branch_id = $1 AND i.status IN ('new','preparing','ready') AND o.status <> 'void'
              AND ($2::station_kind IS NULL OR i.station = $2)
            ORDER BY i.created_at, i.line_no`,
          [q.branchId, q.station ?? null],
        )
      ).rows;
      return {
        items: rows.map((r) => ({
          id: r.id,
          orderId: r.order_id,
          name: r.name,
          qty: r.qty,
          note: r.note,
          status: r.status,
          version: r.version,
          station: r.station,
          round: r.round,
          createdAt: r.created_at,
          statusAt: r.status_at,
          orderNumber: r.number,
          kind: r.kind,
          tableLabel: r.table_label,
          tableZone: r.table_zone,
        })),
      };
    });
  });
}
