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
import { gracefulShutdown } from './shutdown.js';
import { createLogger } from './logger.js';
import { paymentProviderFor } from './payments/providerFor.js';
import { SocketEmitter, nullEmitter } from './realtime/emitter.js';
import { createRealtimeServer } from './realtime/server.js';
import { createAdapterRedis, createQueueRedis, createRedis } from './redis.js';
import { createAdapter } from '@socket.io/redis-adapter';

/**
 * Process entry point.
 *
 * Shutdown is graceful (shutdown.ts): sockets, running jobs and in-flight
 * requests are finished in an order that completes, within a deadline.
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
  let draining = false;
  const server = createServer(createApp(ctx, { isDraining: () => draining }));

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

  const shutdown = gracefulShutdown({
    server,
    realtime,
    workers,
    scheduler,
    db,
    redis: [redis, queueRedis, pubClient, subClient],
    logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    drain: () => {
      draining = true;
    },
    exit: (code) => process.exit(code),
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
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
