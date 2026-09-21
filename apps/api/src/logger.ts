import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

/**
 * Request-scoped logging with request IDs is Phase 5. This is the process
 * logger: startup, shutdown, and anything that escapes a handler.
 */
export function createLogger(config: Config): Logger {
  return pino({
    level: config.LOG_LEVEL,
    // Pretty printing is a dev-only concern and pulls in a transport, so
    // production stays with newline-delimited JSON on stdout.
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } }
      : {}),
  });
}
