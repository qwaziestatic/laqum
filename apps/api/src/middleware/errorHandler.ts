import { AppError, type Clock, type ErrorBody, isAppError } from '@laqum/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

/**
 * The single place an error becomes an HTTP response.
 *
 * Anything that is not a recognised AppError becomes an opaque 500: an
 * unexpected error may carry a connection string or a row of someone else's
 * data, so its detail goes to the log and never to the client.
 */
export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
    } satisfies ErrorBody);
  };
}

export function errorHandler(logger: Logger, clock: Clock): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    if (isAppError(err)) {
      // Every refusal for rate says when to come back, whichever limit it was.
      const retryAt = retryAtOf(err);
      if (err.code === 'RATE_LIMITED' && retryAt !== null) {
        const seconds = Math.ceil((retryAt.getTime() - clock.now().getTime()) / 1000);
        res.set('Retry-After', String(Math.max(1, seconds)));
      }
      if (err.status >= 500) {
        logger.error({ err, path: req.path }, 'request failed');
      } else {
        logger.debug({ code: err.code, path: req.path }, 'request rejected');
      }
      res.status(err.status).json(err.toBody());
      return;
    }

    if (err instanceof ZodError) {
      const appError = new AppError('VALIDATION_ERROR', 'Request validation failed', {
        issues: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      res.status(appError.status).json(appError.toBody());
      return;
    }

    logger.error({ err, path: req.path }, 'unhandled error');
    res.status(500).json({
      error: { code: 'INTERNAL', message: 'Something went wrong' },
    } satisfies ErrorBody);
  };
}

function retryAtOf(err: AppError): Date | null {
  const details = err.details as { retryAt?: unknown } | undefined;
  if (typeof details?.retryAt !== 'string') return null;
  const at = new Date(details.retryAt);
  return Number.isNaN(at.getTime()) ? null : at;
}
