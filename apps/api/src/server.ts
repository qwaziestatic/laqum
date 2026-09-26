import { createServer } from 'node:http';
import { createDb, createPool } from '@laqum/db';
import { systemClock } from '@laqum/shared';
import { createApp } from './app.js';
import { RateLimiter } from './auth/rateLimit.js';
import { ConsoleSmsProvider } from './auth/sms.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { BullMqScheduler, startWorkers } from './jobs/bullmq.js';
import { listen } from './listen.js';
import { createLogger } from './logger.js';
import { paymentProviderFor } from './payments/providerFor.js';
import { SocketEmitter, nullEmitter } from './realtime/emitter.js';
import { createRealtimeServer } from './realtime/server.js';
import { createAdapterRedis, createQueueRedis, createRedis } from './redis.js';
import { createAdapter } from '@socket.io/redis-adapter';

/**
 * Process entry point.
 *
 * Shutdown here closes the HTTP server and the connection pools. Draining
 * in-flight BullMQ jobs and Socket.io connections is Phase 5.
 *
 * The port is bound BEFORE the job workers start, so a process that cannot
 * serve HTTP exits without having picked up any work.
 */
async function main(): Promise<void> {
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

  const provider = paymentProviderFor(config, { clock: systemClock, logger });
  logger.info({ provider: provider.name }, 'payment provider selected');

  const ctx: AppContext = {
    db,
    redis,
    clock: systemClock,
    config,
    logger,
    scheduler,
    sms: new ConsoleSmsProvider(logger),
    rateLimiter: new RateLimiter({ redis, clock: systemClock }),
    provider,
    // Replaced below, once there is an HTTP server to attach Socket.io to.
    emitter: nullEmitter,
  };

  // NOT app.listen(port, callback): Express 5 calls that callback with the
  // bind error, so a failed bind would log "listening". See listen.ts.
  const server = createServer(createApp(ctx));

  /*
   * Realtime, with the Redis adapter.
   *
   * The adapter is what makes more than one API instance possible: a slot
   * change handled by instance A has to reach dashboards connected to
   * instance B, and without it each instance only ever broadcasts to its own
   * sockets. apps/api/test/realtime-multi-instance.test.ts negative-tests
   * that — the same scenario fails when the adapter is removed.
   */
  const { pubClient, subClient } = createAdapterRedis(config);
  const realtime = createRealtimeServer(server, {
    db,
    config,
    clock: systemClock,
    logger,
    adapter: createAdapter(pubClient, subClient),
    rateLimiter: ctx.rateLimiter,
  });
  ctx.emitter = new SocketEmitter(realtime.io);
  logger.info('realtime server attached');

  // Rejects with a ListenError if the bind fails; the catch at the bottom of
  // this file turns that into a loud non-zero exit.
  const bound = await listen(server, config.PORT);
  logger.info(
    { address: bound.address, family: bound.family, port: bound.port, env: config.NODE_ENV },
    'ላቁም? API listening',
  );

  // One process by default. Phase 5 can split the worker out by running a
  // second instance with RUN_WORKER=false here and true there.
  const workers = config.RUN_WORKER
    ? startWorkers(
        { db, clock: systemClock, logger, payments: ctx },
        { connection: queueRedis, clock: systemClock, logger },
      )
    : null;
  if (workers) logger.info({ queues: workers.queueWorkers.length }, 'job workers started');

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    server.close((err) => {
      if (err) logger.error({ err }, 'error closing HTTP server');
      void (async (): Promise<void> => {
        try {
          // Sockets first: closing them lets clients reconnect elsewhere
          // rather than sit on a connection to a process that is going away.
          await realtime.close();
          await workers?.close();
          await scheduler.close();
          await db.destroy();
          redis.disconnect();
          queueRedis.disconnect();
          pubClient.disconnect();
          subClient.disconnect();
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

main().catch((err: unknown) => {
  /*
   * Straight to stderr, not the logger: the logger may not exist yet (bad
   * config is the usual cause), and in development pino writes through a
   * worker-thread transport that an immediate process.exit can cut off.
   * Exiting from the write callback means the message is out first.
   *
   * The exit is explicit because nothing else would end the process: the
   * Redis, BullMQ and Socket.io adapter connections opened before the
   * failure keep the event loop alive indefinitely.
   */
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`ላቁም? API failed to start: ${message}\n`, () => {
    process.exit(1);
  });
});
