import express, { type Express, type Request, type Response } from 'express';
import { authRouter } from './auth/routes.js';
import { bookingsRouter } from './bookings/routes.js';
import { lotsRouter } from './lots/routes.js';
import type { AppContext } from './context.js';
import { checkReadiness } from './health.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export interface AppOptions {
  startedAt?: number;
}

export function createApp(ctx: AppContext, options: AppOptions = {}): Express {
  const app = express();
  const startedAt = options.startedAt ?? Date.now();

  app.disable('x-powered-by');
  // Behind a proxy in production, so req.ip reflects the client rather than
  // the load balancer. Per-IP rate limiting depends on this being right.
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));

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

  app.use('/v1/auth', authRouter(ctx));
  app.use('/v1/lots', lotsRouter(ctx));
  app.use('/v1/bookings', bookingsRouter(ctx));

  app.use(notFoundHandler());
  app.use(errorHandler(ctx.logger));

  return app;
}
