import type { Database } from '@laqum/db';
import type { Clock } from '@laqum/shared';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { RateLimiter } from './auth/rateLimit.js';
import type { SmsProvider } from './auth/sms.js';
import type { Config } from './config.js';
import type { JobScheduler } from './jobs/scheduler.js';

/**
 * Everything a request handler is allowed to reach for, assembled once at
 * startup and threaded explicitly. No module-level singletons: a test builds
 * its own context with a FakeClock and a recording scheduler.
 */
export interface AppContext {
  db: Kysely<Database>;
  redis: Redis;
  clock: Clock;
  config: Config;
  logger: Logger;
  scheduler: JobScheduler;
  sms: SmsProvider;
  rateLimiter: RateLimiter;
}
