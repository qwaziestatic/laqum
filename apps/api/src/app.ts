import express, { type Express, type Request, type Response } from 'express';
import { checkReadiness, type HealthDeps } from './health.js';

export interface AppDeps extends HealthDeps {
  startedAt?: number;
}

/**
 * Phase 0 serves only the two probes. Routers, auth, the error model and the
 * /v1 surface arrive in Phase 1.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  const startedAt = deps.startedAt ?? Date.now();

  app.disable('x-powered-by');
  app.use(express.json());

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
    checkReadiness(deps)
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

  return app;
}
