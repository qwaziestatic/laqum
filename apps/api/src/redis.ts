import { Redis } from 'ioredis';
import type { Config } from './config.js';

/**
 * ioredis defaults to queueing commands while disconnected and retrying
 * forever. That is the right behaviour for BullMQ in Phase 1, but it would
 * make the readiness probe hang instead of reporting "down", so the probe
 * client is configured to fail fast.
 */
/**
 * A SEPARATE connection for BullMQ.
 *
 * BullMQ's blocking commands require `maxRetriesPerRequest: null`, and warn
 * (then misbehave) with anything else — the exact opposite of what the
 * readiness probe needs, which is to fail fast rather than block. The two
 * cannot share a client, so they do not.
 */
export function createQueueRedis(config: Config): Redis {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
}

/**
 * A THIRD pair of connections, for the Socket.io Redis adapter.
 *
 * The subscriber cannot be shared with anything else: a Redis connection in
 * subscribe mode accepts only subscription commands, so the moment the adapter
 * subscribes, that client is unusable for the readiness probe's PING or for
 * BullMQ. `subClient = pubClient.duplicate()` is the documented pairing.
 *
 * Offline queueing stays ON: a broadcast during a brief Redis blip should be
 * delivered late rather than dropped, unlike a readiness probe.
 */
export function createAdapterRedis(config: Config): { pubClient: Redis; subClient: Redis } {
  const pubClient = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  return { pubClient, subClient: pubClient.duplicate() };
}

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
