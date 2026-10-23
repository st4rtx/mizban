import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { withTenant } from '../db/pool.js';
import { buildFacts, generateBrief } from '../services/ai.js';
import { assertBranch } from '../services/orders.js';
import { dayMetrics, detectAnomalies, templateBrief } from '../services/reports.js';

const Q = z.object({ branchId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const BriefQ = Q.extend({ force: z.boolean().default(false) });
const FORCE_COOLDOWN_MS = 60_000; // a manual rewrite is allowed at most once a minute per branch/day
const TEMPLATE_RETRY_MS = 120_000;

export function reportRoutes(app: FastifyInstance, { config, db, guard }: Ctx) {
  app.get('/reports/day', { preHandler: guard(['manager']) }, async (req) => {
    const q = Q.parse(req.query);
    const user = req.user!;
    assertBranch(user, q.branchId);
    return withTenant(db, user.restaurantId, async (tx) => {
      const metrics = await dayMetrics(tx, q.branchId, q.date);
      return { metrics, anomalies: detectAnomalies(metrics) };
    });
  });

  // Separate from the numbers so the dashboard renders instantly and the (slow, fallible) brief fills in after.
  app.post(
    '/reports/day/brief',
    { preHandler: guard(['manager']), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const q = BriefQ.parse(req.body);
      const user = req.user!;
      assertBranch(user, q.branchId);
      const { metrics, anomalies } = await withTenant(db, user.restaurantId, async (tx) => {
        const metrics = await dayMetrics(tx, q.branchId, q.date);
        return { metrics, anomalies: detectAnomalies(metrics) };
      });
      const facts = buildFacts(metrics, anomalies);
      const hash = createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 32);

      const cached = await withTenant(db, user.restaurantId, async (tx) =>
        (await tx.query('SELECT source, body, model, created_at FROM day_briefs WHERE branch_id = $1 AND day = $2 AND input_hash = $3', [q.branchId, q.date, hash])).rows[0],
      );
      // Same numbers, same brief (cost bound). A fallback is retried after 2 minutes. "Rewrite" (force) skips the
      // cache but only once a minute, so the button can never turn into a cost or abuse channel.
      const ageMs = cached ? Date.now() - new Date(cached.created_at).getTime() : Infinity;
      const reuse = cached && (q.force ? ageMs < FORCE_COOLDOWN_MS : cached.source === 'ai' || ageMs < TEMPLATE_RETRY_MS);
      if (cached && reuse) {
        return { source: cached.source, text: cached.body, generatedAt: cached.created_at, cached: true };
      }

      let source: 'ai' | 'template' = 'template';
      let text = templateBrief(metrics, anomalies, false); // the UI lists flags itself
      let latencyMs: number | null = null;
      if (metrics.summary.orders > 0) {
        try {
          const r = await generateBrief(config, facts);
          source = 'ai';
          text = r.text;
          latencyMs = r.latencyMs;
          req.log.info({ latencyMs, branchId: q.branchId, date: q.date }, 'ai brief ok');
        } catch (err) {
          // Provider down, slow, or answer failed validation: owner still gets a correct (plainer) brief.
          req.log.warn({ err: (err as Error).message, branchId: q.branchId }, 'ai brief fell back to template');
        }
      }
      const row = await withTenant(db, user.restaurantId, async (tx) =>
        (
          await tx.query(
            `INSERT INTO day_briefs (restaurant_id, branch_id, day, input_hash, source, body, model, latency_ms)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (branch_id, day, input_hash) DO UPDATE SET source = EXCLUDED.source, body = EXCLUDED.body,
               model = EXCLUDED.model, latency_ms = EXCLUDED.latency_ms, created_at = now()
             RETURNING created_at`,
            [user.restaurantId, q.branchId, q.date, hash, source, text, source === 'ai' ? config.AI_MODEL : null, latencyMs],
          )
        ).rows[0],
      );
      return { source, text, generatedAt: row.created_at, cached: false };
    },
  );
}
