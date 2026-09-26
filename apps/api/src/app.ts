import express, { type Express, type Request, type Response } from 'express';
import { adminRouter } from './admin/routes.js';
import { authRouter } from './auth/routes.js';
import { bookingsRouter } from './bookings/routes.js';
import { lotsRouter } from './lots/routes.js';
import { refundsRouter } from './payments/adminRoutes.js';
import { webhookRouter } from './payments/routes.js';
import { PAYMENT_RETURN_PATH, servePaymentReturnPage } from './payments/returnPage.js';
import { DEV_CHECKOUT_PATH, devCheckoutRouter } from './payments/devCheckout.js';
import { FakePaymentProvider } from './payments/fake.js';
import { pushRouter } from './push/routes.js';
import { staffRouter } from './staff/routes.js';
import type { AppContext } from './context.js';
import { checkReadiness } from './health.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { generalLimit } from './middleware/rateLimit.js';
import { requestLog } from './middleware/requestLog.js';

export interface AppOptions {
  startedAt?: number;
}

export function createApp(ctx: AppContext, options: AppOptions = {}): Express {
  const app = express();
  const startedAt = options.startedAt ?? Date.now();

  app.disable('x-powered-by');
  // First of all, so every request (the webhook's too) has an id on its logs.
  app.use(...requestLog(ctx));
  // req.ip is the client's address only if exactly the proxies in front of
  // us are trusted, and no more: per-IP rate limiting depends on it. See
  // TRUST_PROXY_HOPS in config.ts; `true` let any client choose its own.
  app.set('trust proxy', ctx.config.TRUST_PROXY_HOPS);
  /*
   * The webhook is mounted BEFORE express.json, and parses its own raw body.
   *
   * Order is load-bearing: once express.json has consumed the stream, the
   * exact bytes Chapa signed are gone and the signature can only be checked
   * against a re-serialisation, which is not byte-identical.
   */
  app.use('/v1/webhooks', webhookRouter(ctx));

  app.use(express.json({ limit: '64kb' }));

  // Every /v1 request, per user or per IP before sign-in. Mounted after the
  // webhook, which it therefore never counts, and not on the probes below.
  app.use('/v1', generalLimit(ctx));

  // Liveness. Deliberately dependency-free: it must stay 200 while Postgres is
  // down, or an orchestrator will restart a process that is working fine.
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  // Readiness. 503 when a dependency is unreachable, with per-dependency
  // detail so an operator can see which one without opening a shell.
  app.get('/ready', (_req: Request, res: Response) => {
    checkReadiness({ db: ctx.db, redis: ctx.redis })
      .then((report) => {
        res.status(report.status === 'ready' ? 200 : 503).json(report);
      })
      .catch((err: unknown) => {
        res.status(503).json({
          status: 'not_ready',
          checks: {},
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });

  // Where Chapa sends the driver after its checkout. Outside /v1: a page for
  // a browser, not an API response.
  app.get(PAYMENT_RETURN_PATH, servePaymentReturnPage);

  // The fake provider's checkout. Registered, or absent (the generic 404):
  // config.DEV_CHECKOUT_ENABLED is false in production whatever else is set.
  if (ctx.config.DEV_CHECKOUT_ENABLED && ctx.provider instanceof FakePaymentProvider) {
    app.use(DEV_CHECKOUT_PATH, devCheckoutRouter(ctx, ctx.provider));
  }

  app.use('/v1/auth', authRouter(ctx));
  app.use('/v1/lots', lotsRouter(ctx));
  app.use('/v1/bookings', bookingsRouter(ctx));
  app.use('/v1/push', pushRouter(ctx));
  app.use('/v1/staff', staffRouter(ctx));
  app.use('/v1/admin', adminRouter(ctx));
  app.use('/v1/admin', refundsRouter(ctx));

  app.use(notFoundHandler());
  app.use(errorHandler(ctx.logger, ctx.clock));

  return app;
}
