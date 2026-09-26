import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What every log line is about: the request, or the job, it was written in.
 *
 * Carried in AsyncLocalStorage rather than threaded through every call, so
 * the dozens of `ctx.logger` calls in services, after-commit effects and
 * jobs all carry the request id without being changed. The logger reads it
 * through pino's `mixin` (logger.ts). Verified on Express 5 / Node 24: the
 * context survives body parsing, large bodies included.
 */
export interface LogContext {
  /** The request's id, echoed as X-Request-Id; also on the jobs it scheduled. */
  reqId?: string;
  /** The BullMQ job being run. */
  jobId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}

export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}
