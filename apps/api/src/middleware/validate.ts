import { AppError } from '@laqum/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

/**
 * zod at every API boundary. The parsed, typed value replaces the raw input,
 * so handlers never see an unvalidated field.
 */

function fail(error: unknown): never {
  if (error instanceof Error && 'issues' in error) {
    const issues = (error as { issues: { path: PropertyKey[]; message: string }[] }).issues;
    throw new AppError('VALIDATION_ERROR', 'Request validation failed', {
      issues: issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  throw error;
}

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      try {
        fail(result.error);
      } catch (err) {
        next(err);
        return;
      }
    }
    req.body = result.data;
    next();
  };
}

/**
 * Express 5 makes req.query a getter, so the parsed value is stashed on
 * res.locals rather than assigned back.
 */
export function validateQuery<T>(schema: ZodType<T>): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      try {
        fail(result.error);
      } catch (err) {
        next(err);
        return;
      }
    }
    res.locals['query'] = result.data;
    next();
  };
}

/** Wrap an async handler so a rejection reaches the error middleware. */
export function handle(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}
