import { otpRequestSchema, otpVerifySchema, refreshSchema } from '@laqum/shared';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { handle, validateBody } from '../middleware/validate.js';
import { logout, refreshSession, requestOtp, verifyOtpAndSignIn, type Session } from './service.js';

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
      const { phone } = req.body as { phone: string };
      const { expiresAt } = await requestOtp(deps, { phone, ip: req.ip ?? 'unknown' });

      // 202: the code has been dispatched, not that it has arrived. The
      // response never says whether the number is registered.
      res.status(202).json({ expiresAt: expiresAt.toISOString() });
    }),
  );

  router.post(
    '/otp/verify',
    validateBody(otpVerifySchema),
    handle(async (req, res) => {
      const { phone, code } = req.body as { phone: string; code: string };
      const session = await verifyOtpAndSignIn(deps, { phone, code });
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

  return router;
}
