import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { Config } from './config.js';
import { currentLogContext } from './logContext.js';

/**
 * The process logger: JSON lines on stdout in production, pretty in
 * development. Every line carries the request or job it belongs to
 * (logContext.ts), and nothing that works as a credential is ever written.
 *
 * Logs stay on the server, in Ethiopia (Proclamation 1321/2024, Art. 22);
 * they are rotated by Docker and shipped to no service abroad.
 */

/**
 * Credentials, wherever a log call puts them: replaced, not merely masked.
 * Request logging (middleware/requestLog.ts) never includes headers or
 * bodies at all; this is the second line, for a careless log call.
 */
export const REDACTED_PATHS = [
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
  'headers["x-chapa-signature"]',
  'headers["chapa-signature"]',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'expoPushToken',
  '*.expoPushToken',
  'token',
  '*.token',
  'secretKey',
  '*.secretKey',
];

/** Log keys that hold a phone number. */
const PHONE_KEYS = ['phone', 'to'];

/**
 * +251911234567 → +251*******567: enough to tell two numbers apart in a log,
 * not enough to call anyone. Anything that is not an E.164 number is left
 * alone.
 */
export function maskPhone(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = /^(\+\d{3})(\d+)(\d{3})$/u.exec(value);
  if (!match) return value;
  const [, country = '', middle = '', last = ''] = match;
  return `${country}${'*'.repeat(middle.length)}${last}`;
}

export function loggerOptions(config: Config): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    // The request or job this line was written in; a log call's own fields win.
    mixin: () => ({ ...currentLogContext() }),
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    formatters: {
      log(object) {
        const masked: Record<string, unknown> = { ...object };
        for (const key of PHONE_KEYS) if (key in masked) masked[key] = maskPhone(masked[key]);
        return masked;
      },
    },
  };
}

export function createLogger(config: Config, destination?: DestinationStream): Logger {
  const options = loggerOptions(config);
  if (destination) return pino(options, destination);
  return pino({
    ...options,
    // Pretty printing is a dev-only concern and pulls in a transport, so
    // production stays with newline-delimited JSON on stdout.
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } }
      : {}),
  });
}
