import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.string().default('info'),
  // Connection used by the API at runtime. Role has NO BYPASSRLS.
  DATABASE_URL: z.string().min(1),
  // Owner connection used only by migrations and seed.
  DATABASE_ADMIN_URL: z.string().min(1),
  APP_DB_PASSWORD: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  ALLOWED_ORIGINS: z.string().default(''),
  // Number of reverse proxies in front of the app whose X-Forwarded-For we believe (nginx = 1).
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  DEMO_MODE: z.enum(['true', 'false']).default('false'),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().default('https://api.gapgpt.app/v1'),
  AI_MODEL: z.string().default('gapgpt-qwen-3.5'),
  AI_TIMEOUT_MS: z.coerce.number().default(15000),
  WEB_DIST: z.string().default('../web/dist'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Fail at boot, never run half-configured. Print names of bad vars, never values.
    const bad = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${bad}`);
  }
  return parsed.data;
}
