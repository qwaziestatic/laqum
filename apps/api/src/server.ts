import { createDb, createPool } from '@laqum/db';
import { systemClock } from '@laqum/shared';
import { createApp } from './app.js';
import { RateLimiter } from './auth/rateLimit.js';
import { ConsoleSmsProvider } from './auth/sms.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { BullMqScheduler, startWorkers } from './jobs/bullmq.js';
import { createLogger } from './logger.js';
import { createQueueRedis, createRedis } from './redis.js';

/**
 * Process entry point.
 *
 * Shutdown here closes the HTTP server and the connection pools. Draining
 * in-flight BullMQ jobs and Socket.io connections is Phase 5.
 */
function main(): void {
  const config = loadConfig();
  const logger = createLogger(config);

  const pool = createPool({ connectionString: config.DATABASE_URL });
  const db = createDb(pool);
  const redis = createRedis(config);

  redis.connect().catch((err: unknown) => {
    logger.warn({ err }, 'Redis is not reachable at startup; /ready will report it');
  });

  // BullMQ needs maxRetriesPerRequest: null for its blocking commands, which
  // is the opposite of what the readiness probe wants. Separate connections.
  const queueRedis = createQueueRedis(config);
  const scheduler = new BullMqScheduler({ connection: queueRedis, clock: systemClock, logger });

  const ctx: AppContext = {
    db,
    redis,
    clock: systemClock,
    config,
    logger,
    scheduler,
    sms: new ConsoleSmsProvider(logger),
    rateLimiter: new RateLimiter({ redis, clock: systemClock }),
  };

  // One process by default. Phase 5 can split the worker out by running a
  // second instance with RUN_WORKER=false here and true there.
  const workers = config.RUN_WORKER
    ? startWorkers(
        { db, clock: systemClock, logger },
        { connection: queueRedis, clock: systemClock, logger },
      )
    : null;
  if (workers) logger.info({ queues: workers.queueWorkers.length }, 'job workers started');

  const app = createApp(ctx);
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'ላቁም? API listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    server.close((err) => {
      if (err) logger.error({ err }, 'error closing HTTP server');
      void (async (): Promise<void> => {
        try {
          await workers?.close();
          await scheduler.close();
          await db.destroy();
          redis.disconnect();
          queueRedis.disconnect();
        } catch (closeErr) {
          logger.error({ err: closeErr }, 'error closing connections');
        } finally {
          process.exit(err ? 1 : 0);
        }
      })();
    });

    setTimeout(() => {
      logger.error('forced exit after shutdown timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

try {
  main();
} catch (err: unknown) {
  // The logger may not exist yet (bad config is the usual cause), so this
  // writes to stderr directly.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
