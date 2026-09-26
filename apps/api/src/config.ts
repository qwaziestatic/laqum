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

  /*
   * THE REST OF THE RATE LIMITS (Phase 5; the numbers are the product
   * owner's starting point, each overridable here). Counted in Redis, in
   * fixed windows, by middleware/rateLimit.ts.
   *
   * By USER wherever there is one, by IP only before sign-in: a mobile
   * carrier can put many phones behind one public address, so a tight
   * per-IP limit would block strangers together. Per-IP limits exist to stop
   * floods, and are generous.
   */
  /** Every /v1 request, per signed-in user, or per IP before sign-in. */
  RATE_LIMIT_GENERAL_PER_MINUTE: z.coerce.number().int().positive().default(300),
  /** Book, cancel, extend, pay and pay the deposit, per user. */
  RATE_LIMIT_BOOKING_WRITES_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** Every staff action (check-in, walk-in, check-out, cash, service), per attendant. */
  RATE_LIMIT_STAFF_ACTIONS_PER_MINUTE: z.coerce.number().int().positive().default(120),
  /** OTP verification attempts per IP, over OTP_RATE_LIMIT_WINDOW_MINUTES. */
  RATE_LIMIT_OTP_VERIFY_PER_IP: z.coerce.number().int().positive().default(30),
  /** Socket.io connections per IP. The Chapa webhook has no per-IP limit at all. */
  RATE_LIMIT_SOCKET_CONNECTIONS_PER_MINUTE: z.coerce.number().int().positive().default(30),

  /**
   * How many reverse proxies stand in front of this process: EXACTLY. 0 when
   * clients connect straight to it (development, the device test), 1 behind
   * Caddy. req.ip, and every per-IP limit with it, comes from this.
   *
   * It used to be `trust proxy: true`, which believes the whole
   * X-Forwarded-For header: any client could send its own and pick its own
   * address, so the per-IP OTP limit was one header away from not existing.
   * With a count, only the entries the proxies themselves appended are
   * trusted. Too high is as bad as `true` (a client's own entry is read as
   * the proxy's), too low makes every client look like the proxy.
   *
   * A single digit, nothing else: 'true' or '' is a startup error, never a
   * quiet default. REQUIRED when NODE_ENV is production.
   */
  TRUST_PROXY_HOPS: z
    .string()
    .regex(/^\d$/u, 'must be a single digit: the number of proxies in front of the API')
    .transform(Number)
    .optional(),

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
  /**
   * Seconds before a FakePaymentProvider payment reports success BY ITSELF.
   * Unset: never by itself; the development checkout page (Pay / Fail)
   * decides, as a driver does at Chapa's. A number keeps the old automatic
   * success for unattended runs; Pay or Fail still wins if pressed first.
   */
  FAKE_PAYMENT_DELAY_SECONDS: z.coerce.number().int().nonnegative().optional(),

  /** Run the BullMQ worker in this process. Split out in Phase 5 if needed. */
  RUN_WORKER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /**
   * Enables POST /v1/auth/dev-login, which mints a token pair for a seeded
   * user with no OTP. It exists so the dashboard and the Playwright two-screen
   * test can sign in without an SMS round-trip.
   *
   * FAIL CLOSED, in three ways:
   *   - the default is 'false', so an UNSET environment disables it;
   *   - only the exact string 'true' enables it — a typo, '1', or 'yes' is a
   *     schema error at startup, not a quiet enable;
   *   - NODE_ENV === 'production' disables it regardless of this value, so the
   *     endpoint cannot exist in production even by misconfiguration.
   *
   * The gate the code reads is DEV_AUTH_ENABLED below, never this value.
   */
  DEV_AUTH: z
    .enum(['true', 'false'])
    .default('false')
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
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'TRUST_PROXY_HOPS'] as const) {
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
    // Required in production (above); nothing in front of it otherwise.
    TRUST_PROXY_HOPS: cfg.TRUST_PROXY_HOPS ?? 0,
    /*
     * The ONLY gate on dev auth. Derived here rather than at the call site so
     * that there is exactly one place the conjunction is written; a future
     * route that checks `DEV_AUTH` alone would be a bug, and this makes the
     * safe value the obvious one to reach for.
     */
    DEV_AUTH_ENABLED: cfg.DEV_AUTH && cfg.NODE_ENV !== 'production',
    /*
     * The ONLY gate on the development checkout page (payments/devCheckout.ts),
     * written once for the same reason: the fake provider, and never in
     * production, whatever else is set.
     */
    DEV_CHECKOUT_ENABLED: cfg.PAYMENT_PROVIDER === 'fake' && cfg.NODE_ENV !== 'production',
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
