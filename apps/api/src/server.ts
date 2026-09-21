import { createPool, createUntypedDb } from '@laqum/db';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createRedis } from './redis.js';

/**
 * Process entry point.
 *
 * Shutdown here closes the HTTP server and the two connection pools. Draining
 * in-flight BullMQ jobs and Socket.io connections is Phase 5, when there is
 * something to drain.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const pool = createPool({ connectionString: config.DATABASE_URL });
  const db = createUntypedDb(pool);
  const redis = createRedis(config);

  // lazyConnect: connect once at startup so readiness reflects a real
  // connection rather than the first probe paying the connect cost.
  redis.connect().catch((err: unknown) => {
    logger.warn({ err }, 'Redis is not reachable at startup; /ready will report it');
  });

  const app = createApp({ db, redis });
  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV },
      'ላቁም? API listening',
    );
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
          await db.destroy();
          redis.disconnect();
        } catch (closeErr) {
          logger.error({ err: closeErr }, 'error closing connections');
        } finally {
          process.exit(err ? 1 : 0);
        }
      })();
    });

    // Do not let a stuck connection hold the process open forever.
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
  // The logger may not exist yet (bad config is the usual cause), so this
  // writes to stderr directly.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
