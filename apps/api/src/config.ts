import { z } from 'zod';

/**
 * Environment is validated once, at startup, and never read from
 * process.env again. A missing or malformed variable should stop the process
 * immediately with a readable message, not surface as a confusing failure on
 * the first request that happens to need it.
 */

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

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

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
});

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
