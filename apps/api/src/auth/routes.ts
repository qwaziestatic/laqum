import {
  type OtpRequest,
  type OtpVerify,
  devLoginSchema,
  otpRequestSchema,
  otpVerifySchema,
  refreshSchema,
} from '@laqum/shared';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { handle, validateBody } from '../middleware/validate.js';
import {
  devSignIn,
  logout,
  refreshSession,
  requestOtp,
  verifyOtpAndSignIn,
  type Session,
} from './service.js';

function toSessionResponse(session: Session): unknown {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessExpiresAt: session.accessExpiresAt.toISOString(),
    refreshExpiresAt: session.refreshExpiresAt.toISOString(),
    user: session.user,
  };
}

export function authRouter(ctx: AppContext): Router {
  const router = Router();
  const deps = {
    db: ctx.db,
    clock: ctx.clock,
    config: ctx.config,
    logger: ctx.logger,
    sms: ctx.sms,
    rateLimiter: ctx.rateLimiter,
  };

  router.post(
    '/otp/request',
    validateBody(otpRequestSchema),
    handle(async (req, res) => {
      const { phone, audience } = req.body as OtpRequest;
      const { expiresAt } = await requestOtp(deps, { phone, audience, ip: req.ip ?? 'unknown' });

      // 202: the code has been dispatched, not that it has arrived. The
      // response never says whether the number is registered — nor, for the
      // staff audience, whether it is staff (see OTP_AUDIENCES).
      res.status(202).json({ expiresAt: expiresAt.toISOString() });
    }),
  );

  router.post(
    '/otp/verify',
    validateBody(otpVerifySchema),
    handle(async (req, res) => {
      const { phone, code, audience } = req.body as OtpVerify;
      const session = await verifyOtpAndSignIn(deps, { phone, code, audience });
      res.status(200).json(toSessionResponse(session));
    }),
  );

  router.post(
    '/refresh',
    validateBody(refreshSchema),
    handle(async (req, res) => {
      const { refreshToken } = req.body as { refreshToken: string };
      const session = await refreshSession(deps, refreshToken);
      res.status(200).json(toSessionResponse(session));
    }),
  );

  router.post(
    '/logout',
    validateBody(refreshSchema),
    handle(async (req, res) => {
      const { refreshToken } = req.body as { refreshToken: string };
      await logout(deps, refreshToken);
      res.status(204).end();
    }),
  );

  /*
   * DEV LOGIN — signs in a seeded user by phone, with no OTP.
   *
   * It exists so `pnpm dev` and the Playwright two-screen test can get a token
   * without an SMS round-trip. It is also, obviously, a complete bypass of
   * authentication, so it FAILS CLOSED: the route is not even registered
   * unless config.DEV_AUTH_ENABLED, which requires an explicit DEV_AUTH=true
   * AND a non-production NODE_ENV (see config.ts).
   *
   * Not registering it — rather than registering a handler that checks the
   * flag — means that when it is off, the endpoint does not exist: it 404s
   * exactly like any unknown path, and a bug in a guard clause cannot expose
   * it, because there is no guard clause to get wrong.
   */
  if (ctx.config.DEV_AUTH_ENABLED) {
    ctx.logger.warn(
      'DEV_AUTH is enabled: POST /v1/auth/dev-login signs in any seeded user without an OTP',
    );

    // A probe the dashboard uses to decide whether to OFFER dev sign-in.
    // Registered only here, so with DEV_AUTH off it 404s like any unknown
    // path and the dashboard shows the OTP sign-in alone.
    router.get('/dev-login', (_req, res) => {
      res.status(204).end();
    });

    router.post(
      '/dev-login',
      validateBody(devLoginSchema),
      handle(async (req, res) => {
        const { phone } = req.body as { phone: string };
        const session = await devSignIn(deps, phone);
        res.status(200).json(toSessionResponse(session));
      }),
    );
  } else if (ctx.config.DEV_AUTH) {
    // Asked for, and refused. Silence here would leave an operator believing
    // dev login was available and debugging the wrong thing.
    ctx.logger.warn(
      { nodeEnv: ctx.config.NODE_ENV },
      'DEV_AUTH=true was IGNORED: dev login is never enabled when NODE_ENV is production',
    );
  }

  return router;
}
