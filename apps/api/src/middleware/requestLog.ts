import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import type { AppContext } from '../context.js';
import { withLogContext } from '../logContext.js';

/**
 * REQUEST IDS AND THE ACCESS LOG. Mounted first, so the webhook has an id
 * too.
 *
 * Every request gets an id: the caller's X-Request-Id if it is a short, safe
 * token (so a proxy's or a client's id can be followed through), otherwise a
 * fresh UUID. It is echoed as X-Request-Id and carried in the log context,
 * so every line written while handling the request, and in the jobs it
 * schedules, carries it.
 *
 * The access line holds the method, the PATH (never the query string), the
 * status, the time taken and the client's address: no headers, no body, so
 * no token or code can reach it. The probes are not logged; they would be
 * most of the log.
 */

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/u;
const PROBES = new Set(['/health', '/ready']);

export function requestIdFor(incoming: string | undefined): string {
  return incoming !== undefined && SAFE_ID.test(incoming) ? incoming : randomUUID();
}

const pathOf = (url: string | undefined): string => (url ?? '').split('?')[0] ?? '';

export function requestLog(ctx: AppContext): RequestHandler[] {
  const assignId: RequestHandler = (req, res, next) => {
    const reqId = requestIdFor(req.get('x-request-id'));
    (req as Request & { id: string }).id = reqId;
    res.set('X-Request-Id', reqId);
    withLogContext({ reqId }, next);
  };

  const access = pinoHttp({
    logger: ctx.logger,
    // assignId (above) has already set it.
    genReqId: (req) => req.id,
    autoLogging: { ignore: (req) => PROBES.has(pathOf(req.url)) },
    customLogLevel: (_req, res: ServerResponse, err) =>
      err !== undefined || res.statusCode >= 500 ? 'error' : 'info',
    serializers: {
      req: (req: IncomingMessage & { id?: string; raw?: { ip?: string } }) => ({
        method: req.method,
        path: pathOf(req.url),
        ip: req.raw?.ip,
      }),
      res: (res: { statusCode: number }) => ({ status: res.statusCode }),
    },
  });

  return [assignId, access];
}
