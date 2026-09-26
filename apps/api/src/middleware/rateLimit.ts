import { AppError } from '@laqum/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyAccessToken } from '../auth/tokens.js';
import type { AppContext } from '../context.js';

/**
 * RATE LIMITS, as middleware over the Redis RateLimiter the OTP flow already
 * uses: fixed windows, counted on the injected clock (so tests move time
 * rather than sleep), shared by every API instance.
 *
 * Keyed by USER wherever there is one and by IP only before sign-in, because
 * a mobile carrier can put many phones behind one public address. A refusal
 * is 429 RATE_LIMITED with `details.retryAt`; the error handler turns that
 * into a Retry-After header.
 *
 * WHEN REDIS IS DOWN: the counters live there. The broad limits FAIL OPEN
 * (the request goes through, with a warning), because a Redis blip must not
 * turn into "no attendant can check anyone in". The OTP limits FAIL CLOSED,
 * as the OTP request limit always has: an outage must not become the window
 * in which codes can be guessed freely.
 *
 * Not limited here: /health and /ready (probes), the Chapa webhook (its
 * signature and the verify call protect it, and Chapa's addresses are not
 * ours to guess), and the pages outside /v1.
 */

interface Limit {
  key: string;
  limit: number;
  windowMinutes: number;
  /** For the log and the developer message; never shown to a user. */
  what: string;
  /** Let the request through when the counter cannot be reached. */
  failOpen: boolean;
}

function limited(
  ctx: AppContext,
  pick: (req: Request, res: Response) => Promise<Limit | null> | Limit | null,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async (): Promise<void> => {
      const limit = await pick(req, res);
      if (limit === null) return;
      let result;
      try {
        result = await ctx.rateLimiter.hit(limit.key, limit.limit, limit.windowMinutes);
      } catch (err) {
        if (!limit.failOpen) throw err;
        ctx.logger.warn({ err, limit: limit.what }, 'rate limit not counted: Redis unreachable');
        return;
      }
      if (!result.allowed) {
        throw new AppError('RATE_LIMITED', `Too many ${limit.what}`, {
          retryAt: result.resetAt.toISOString(),
        });
      }
    })()
      .then(() => {
        next();
      })
      .catch(next);
  };
}

const ip = (req: Request): string => req.ip ?? 'unknown';

/**
 * Who is calling, for the general limit: the user of a valid access token, or
 * the address. An invalid token counts against the address; the route's own
 * requireAuth then refuses it.
 */
async function caller(ctx: AppContext, req: Request): Promise<string> {
  const header = req.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    try {
      const claims = await verifyAccessToken(ctx.config, ctx.clock, header.slice(7).trim());
      return `user:${claims.userId}`;
    } catch {
      // Falls through to the address.
    }
  }
  return `ip:${ip(req)}`;
}

/** Every /v1 request: per user, or per IP before sign-in. */
export function generalLimit(ctx: AppContext): RequestHandler {
  return limited(ctx, async (req) => ({
    key: `general:${await caller(ctx, req)}`,
    limit: ctx.config.RATE_LIMIT_GENERAL_PER_MINUTE,
    windowMinutes: 1,
    what: 'requests',
    failOpen: true,
  }));
}

/** After requireAuth: book, cancel, extend, pay, pay the deposit. */
export function bookingWriteLimit(ctx: AppContext): RequestHandler {
  return limited(ctx, (_req, res) => ({
    key: `booking-writes:user:${res.locals.user?.userId ?? 'unknown'}`,
    limit: ctx.config.RATE_LIMIT_BOOKING_WRITES_PER_MINUTE,
    windowMinutes: 1,
    what: 'booking changes',
    failOpen: true,
  }));
}

/** After requireAuth, on a staff router: every action, never a read. */
export function staffActionLimit(ctx: AppContext): RequestHandler {
  return limited(ctx, (req, res) =>
    req.method === 'GET' || req.method === 'HEAD'
      ? null
      : {
          key: `staff-actions:user:${res.locals.user?.userId ?? 'unknown'}`,
          limit: ctx.config.RATE_LIMIT_STAFF_ACTIONS_PER_MINUTE,
          windowMinutes: 1,
          what: 'staff actions',
          failOpen: true,
        },
  );
}

/** OTP verification attempts per address; a code's own 5 attempts still apply. */
export function otpVerifyLimit(ctx: AppContext): RequestHandler {
  return limited(ctx, (req) => ({
    key: `otp-verify:ip:${ip(req)}`,
    limit: ctx.config.RATE_LIMIT_OTP_VERIFY_PER_IP,
    windowMinutes: ctx.config.OTP_RATE_LIMIT_WINDOW_MINUTES,
    what: 'code attempts',
    failOpen: false,
  }));
}
