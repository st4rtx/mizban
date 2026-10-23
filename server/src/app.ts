/**
 * Docs:
 * - Architecture: /docs/architecture/overview.md
 * - API: /docs/api/README.md
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { withTenant, type Db } from './db/pool.js';
import { AppError, forbidden, unauthorized } from './lib/errors.js';
import { verifySession } from './lib/session.js';
import type { AuthUser } from './services/orders.js';
import { authRoutes } from './routes/auth.js';
import { floorRoutes } from './routes/floor.js';
import { orderRoutes } from './routes/orders.js';
import { kitchenRoutes } from './routes/kitchen.js';
import { reportRoutes } from './routes/reports.js';
import { eventRoutes } from './routes/events.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export interface Deps {
  config: Config;
  db: Db;
}

export type Role = AuthUser['role'];

export async function buildApp({ config, db }: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      serializers: {
        req: (r) => ({ method: r.method, url: r.url.split('?')[0], id: r.id, ip: r.ip }),
      },
    },
    genReqId: (req) => (req.headers['x-request-id'] as string)?.slice(0, 64) || crypto.randomUUID(),
    trustProxy: (_addr: string, hop: number) => hop < config.TRUST_PROXY_HOPS, // believe only the first N proxy hops
    bodyLimit: 64 * 1024,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // CSRF: the session cookie is SameSite=Lax; additionally reject cross-origin state changes.
  const allowed = new Set(config.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean));
  app.addHook('onRequest', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return;
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    let ok = allowed.has(origin);
    try {
      ok ||= new URL(origin).host === host;
    } catch {
      ok = false;
    }
    if (!ok) throw forbidden('درخواست از مبدأ غیرمجاز');
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'validation', message: 'ورودی نامعتبر است', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err }, 'app error');
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const fe = err as { statusCode?: number; code?: string; message: string };
    if (fe.statusCode && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: { code: fe.code ?? 'bad_request', message: fe.statusCode === 429 ? 'درخواست‌های زیاد؛ کمی بعد تلاش کنید' : 'درخواست نامعتبر' } });
    }
    // Fail closed: never leak internals, always give the operator a request id to grep for.
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'خطای داخلی. شناسه پیگیری: ' + req.id } });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'not_found', message: 'مسیر وجود ندارد' } });
    return serveIndex(reply);
  });

  /** preHandler factory: authenticates the session cookie and checks the role. Fails closed. */
  const guard = (roles?: Role[]) => async (req: FastifyRequest) => {
    const claims = verifySession(req.cookies.mz_session, config.SESSION_SECRET);
    if (!claims) throw unauthorized();
    const user = await withTenant(db, claims.rid, async (tx) => {
      const r = (await tx.query('SELECT id, restaurant_id, branch_id, role, display_name, active FROM users WHERE id = $1', [claims.uid])).rows[0];
      return r?.active ? r : null;
    });
    if (!user) throw unauthorized('نشست نامعتبر است');
    if (roles && !roles.includes(user.role)) throw forbidden();
    req.user = { id: user.id, restaurantId: user.restaurant_id, branchId: user.branch_id, role: user.role, name: user.display_name };
  };

  const ctx = { config, db, guard };
  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });
  await app.register(async (api) => {
    authRoutes(api, ctx);
    floorRoutes(api, ctx);
    orderRoutes(api, ctx);
    kitchenRoutes(api, ctx);
    reportRoutes(api, ctx);
    eventRoutes(api, ctx);
  }, { prefix: '/api' });

  const webDist = resolve(config.WEB_DIST);
  const hasWeb = existsSync(webDist);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, setHeaders: (res, path) => {
      if (path.includes('/assets/')) res.header('cache-control', 'public, max-age=31536000, immutable');
    } });
  }
  function serveIndex(reply: FastifyReply) {
    if (!hasWeb) return reply.status(404).send({ error: { code: 'not_found', message: 'UI not built' } });
    return reply.header('cache-control', 'no-cache').sendFile('index.html');
  }
  return app;
}

export type Ctx = {
  config: Config;
  db: Db;
  guard: (roles?: Role[]) => (req: FastifyRequest) => Promise<void>;
};
