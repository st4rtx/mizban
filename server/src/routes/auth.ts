import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { withTenant } from '../db/pool.js';
import { AppError, unauthorized } from '../lib/errors.js';
import { DUMMY_HASH, verifyPassword } from '../lib/password.js';
import { signSession } from '../lib/session.js';

const SESSION_HOURS = 12;

/**
 * Second login limiter keyed on username only. The IP-based limiter above can be sidestepped by anyone who can
 * vary their apparent address, so this one does not look at the IP at all. Trade-off: someone can briefly
 * lock a known username out (30 tries/min); that is cheaper than letting a password be guessed.
 */
const attempts = new Map<string, { n: number; reset: number }>();
function tooManyForUser(username: string, now = Date.now()): boolean {
  const key = username.toLowerCase();
  const cur = attempts.get(key);
  if (!cur || cur.reset < now) {
    if (attempts.size > 5000) for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
    attempts.set(key, { n: 1, reset: now + 60_000 });
    return false;
  }
  return ++cur.n > 30;
}

const Login = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) });

export function authRoutes(app: FastifyInstance, { config, db, guard }: Ctx) {
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: 8,
          timeWindow: '1 minute',
          // per IP + username so one attacker cannot lock out everybody and a shared café Wi-Fi is not punished as one
          keyGenerator: (req) => `${req.ip}:${String((req.body as { username?: string } | undefined)?.username ?? '').toLowerCase()}`,
        },
      },
    },
    async (req, reply) => {
      const { username, password } = Login.parse(req.body);
      if (tooManyForUser(username)) throw new AppError(429, 'rate_limited', 'تلاش‌های ناموفق زیاد بود؛ یک دقیقه بعد دوباره امتحان کنید');
      const u = (await db.query('SELECT * FROM auth_lookup($1)', [username.trim().toLowerCase()])).rows[0];
      // Same work for unknown user and wrong password: no user enumeration by timing.
      const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
      if (!u || !ok || !u.active) {
        req.log.warn({ username }, 'login failed');
        throw unauthorized('نام کاربری یا رمز عبور درست نیست');
      }
      const token = signSession({ uid: u.id, rid: u.restaurant_id, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 }, config.SESSION_SECRET);
      reply.setCookie('mz_session', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.COOKIE_SECURE === 'true',
        path: '/',
        maxAge: SESSION_HOURS * 3600,
      });
      req.log.info({ userId: u.id, restaurantId: u.restaurant_id }, 'login ok');
      return { ok: true };
    },
  );

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie('mz_session', { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: guard() }, async (req) => {
    const u = req.user!;
    return withTenant(db, u.restaurantId, async (tx) => {
      const r = (await tx.query('SELECT id, name, service_pct, vat_pct, floor_discount_max_pct FROM restaurants WHERE id = $1', [u.restaurantId])).rows[0];
      const branches = (
        await tx.query('SELECT id, name FROM branches WHERE ($1::uuid IS NULL OR id = $1) ORDER BY name', [u.branchId])
      ).rows;
      return {
        user: { id: u.id, name: u.name, role: u.role, branchId: u.branchId },
        restaurant: { id: r.id, name: r.name, servicePct: r.service_pct, vatPct: r.vat_pct, floorDiscountMaxPct: r.floor_discount_max_pct },
        branches,
      };
    });
  });

  // Demo credentials are only listed when DEMO_MODE=true. Passwords are shown by design in the demo.
  app.get('/auth/demo', async () => {
    if (config.DEMO_MODE !== 'true') return { accounts: [] };
    return {
      accounts: [
        { username: 'sara', password: 'demo1234', label: 'سارا نیک‌نام', role: 'manager', note: 'مدیر هر دو شعبه نارنج' },
        { username: 'ali', password: 'demo1234', label: 'علی رضایی', role: 'floor', note: 'گارسون، شعبه سعادت‌آباد' },
        { username: 'maryam', password: 'demo1234', label: 'مریم کاظمی', role: 'floor', note: 'صندوق، شعبه سعادت‌آباد' },
        { username: 'reza', password: 'demo1234', label: 'استاد رضا', role: 'kitchen', note: 'آشپزخانه و بار، سعادت‌آباد' },
        { username: 'bagh', password: 'demo1234', label: 'مدیر چای‌خانه باغ', role: 'manager', note: 'رستوران دوم (برای دیدن جدایی داده‌ها)' },
      ],
    };
  });
}
