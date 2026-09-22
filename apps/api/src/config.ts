import { z } from 'zod';

/**
 * Environment is validated once, at startup, and never read from
 * process.env again. A missing or malformed variable should stop the process
 * immediately with a readable message, not surface as a confusing failure on
 * the first request that happens to need it.
 */

// 'silent' is a real pino level and is what tests use to keep output readable.
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

const postgresUrl = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    'must be a postgres:// or postgresql:// connection string',
  );

const redisUrl = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
    'must be a redis:// or rediss:// connection string',
  );

/**
 * Signing keys are OPTIONAL in the schema but required in production.
 *
 * Development and tests get a fixed, obviously-fake default so the stack runs
 * out of the box; production refuses to start without real ones. A silent dev
 * default leaking into production is the failure this shape prevents.
 */
const DEV_ACCESS_SECRET = 'dev-only-access-secret-not-for-production-use';
const DEV_REFRESH_SECRET = 'dev-only-refresh-secret-not-for-production-use';

const secret = z.string().min(32, 'must be at least 32 characters');

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,

  JWT_ACCESS_SECRET: secret.optional(),
  JWT_REFRESH_SECRET: secret.optional(),
  /** Short-lived, per the brief. */
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /** OTPs expire in 5 minutes and allow at most 5 attempts. */
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /**
   * Rate limits for OTP requests. The brief requires per-phone and per-IP
   * limiting but does not specify numbers; these are chosen, not derived.
   */
  OTP_RATE_LIMIT_PER_PHONE: z.coerce.number().int().positive().default(3),
  OTP_RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(10),
  OTP_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

  // ─── Payments ───────────────────────────────────────────────────────────
  /** 'fake' for development and every automated test; 'chapa' for real money. */
  PAYMENT_PROVIDER: z.enum(['fake', 'chapa']).default('fake'),
  /** Chapa secret key. Test keys are prefixed CHASECK_TEST-. */
  CHAPA_SECRET_KEY: z.string().min(1).optional(),
  /** Secret the webhook signature is verified against. */
  CHAPA_WEBHOOK_SECRET: z.string().min(1).default('dev-only-webhook-secret'),
  CHAPA_BASE_URL: z.string().min(1).default('https://api.chapa.co'),
  /** Public base URL Chapa calls back to, and returns the driver to. */
  PUBLIC_BASE_URL: z.string().min(1).default('http://localhost:3000'),
  /**
   * How long past a hold deadline we keep deferring expiry while the provider
   * is unreachable, before expiring anyway. Bounds how long one outage can
   * hold a slot hostage; a payment that lands later goes to the refund queue.
   */
  PAYMENT_VERIFY_DEFERRAL_MINUTES: z.coerce.number().int().positive().default(15),
  /** Seconds before a FakePaymentProvider payment reports success. */
  FAKE_PAYMENT_DELAY_SECONDS: z.coerce.number().int().nonnegative().default(0),

  /** Run the BullMQ worker in this process. Split out in Phase 5 if needed. */
  RUN_WORKER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export const configSchema = baseSchema
  .superRefine((cfg, ctx) => {
    if (cfg.PAYMENT_PROVIDER === 'chapa' && cfg.CHAPA_SECRET_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['CHAPA_SECRET_KEY'],
        message: 'is required when PAYMENT_PROVIDER is chapa',
      });
    }
    if (cfg.NODE_ENV !== 'production') return;
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      if (cfg[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required when NODE_ENV is production',
        });
      }
    }
  })
  .transform((cfg) => ({
    ...cfg,
    JWT_ACCESS_SECRET: cfg.JWT_ACCESS_SECRET ?? DEV_ACCESS_SECRET,
    JWT_REFRESH_SECRET: cfg.JWT_REFRESH_SECRET ?? DEV_REFRESH_SECRET,
  }));

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
