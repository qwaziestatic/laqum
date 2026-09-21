import { Redis } from 'ioredis';
import type { Config } from './config.js';

/**
 * ioredis defaults to queueing commands while disconnected and retrying
 * forever. That is the right behaviour for BullMQ in Phase 1, but it would
 * make the readiness probe hang instead of reporting "down", so the probe
 * client is configured to fail fast.
 */
export function createRedis(config: Config): Redis {
  return new Redis(config.REDIS_URL, {
    // Report the failure rather than buffering the command.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    // Cap the reconnect backoff so a recovered Redis is picked up promptly.
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    lazyConnect: true,
  });
}
