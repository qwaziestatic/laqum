import type { Server } from 'node:http';
import type { Logger } from 'pino';

/**
 * GRACEFUL SHUTDOWN, in an order that actually finishes.
 *
 * The old order closed the HTTP server and only THEN, in its callback, the
 * sockets. But an open WebSocket keeps `server.close()` from ever calling
 * back (verified: 3 s and waiting with one socket open), so every deploy with
 * a dashboard open ran into the forced exit with code 1, and the job workers
 * were never closed at all.
 *
 * Now, on SIGTERM or SIGINT:
 *
 *   1. /ready answers 503, so a proxy stops sending new work;
 *   2. the server stops accepting connections and drops the idle ones;
 *   3. side by side: the sockets are cut (clients reconnect, to the next
 *      process, and resync, as after any drop); the job workers finish the
 *      jobs they are running and take no more; requests in progress finish;
 *   4. then the database and Redis are closed, and the process exits 0.
 *
 * Past the deadline every connection is cut and it exits 1. The deadline sits
 * below Docker's stop grace period, so this process, not SIGKILL, decides.
 */

export interface ShutdownParts {
  server: Server;
  realtime: { close(): Promise<void> };
  workers: { close(): Promise<void> } | null;
  scheduler: { close(): Promise<void> };
  db: { destroy(): Promise<void> };
  redis: { disconnect(): void }[];
  logger: Logger;
  timeoutMs: number;
  /** Makes /ready answer 503. */
  drain: () => void;
  exit: (code: number) => void;
}

export function gracefulShutdown(parts: ShutdownParts): (signal: string) => Promise<void> {
  let started = false;

  return async (signal) => {
    if (started) return;
    started = true;
    const began = Date.now();
    parts.logger.info({ signal }, 'shutting down');

    const deadline = setTimeout(() => {
      parts.logger.error(
        { timeoutMs: parts.timeoutMs },
        'shutdown deadline passed: cutting connections',
      );
      parts.server.closeAllConnections();
      parts.exit(1);
    }, parts.timeoutMs);
    deadline.unref();

    try {
      parts.drain();

      // No new connections; the callback comes once the last one has ended.
      const httpClosed = new Promise<void>((resolve) => {
        parts.server.close(() => {
          resolve();
        });
      });
      // close() drops only the connections idle AT THAT MOMENT. A keep-alive
      // connection whose request finishes afterwards would otherwise linger
      // until its keep-alive timeout (measured: 3.4 s), so keep dropping them.
      parts.server.closeIdleConnections();
      const dropIdle = setInterval(() => {
        parts.server.closeIdleConnections();
      }, 100);
      dropIdle.unref();

      // Side by side, all needing the database still open:
      await Promise.all([
        // every socket cut at once (io.close then waits for the server);
        parts.realtime.close(),
        // running jobs finish, and no new ones start;
        (async () => {
          await parts.workers?.close();
          await parts.scheduler.close();
        })(),
        // requests already in progress finish.
        httpClosed,
      ]);
      clearInterval(dropIdle);

      await parts.db.destroy();
      for (const client of parts.redis) client.disconnect();

      clearTimeout(deadline);
      parts.logger.info({ ms: Date.now() - began }, 'shut down cleanly');
      parts.exit(0);
    } catch (err) {
      clearTimeout(deadline);
      parts.logger.error({ err }, 'error during shutdown');
      parts.exit(1);
    }
  };
}
