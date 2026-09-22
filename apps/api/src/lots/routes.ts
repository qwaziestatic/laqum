import { type NearbyQuery, nearbyQuerySchema, uuidSchema } from '@laqum/shared';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { requireAuth } from '../middleware/auth.js';
import { handle, validateQuery } from '../middleware/validate.js';
import { findNearbyLots, getLot, getLotLayout } from './service.js';

export function lotsRouter(ctx: AppContext): Router {
  const router = Router();

  // Every lot endpoint requires a signed-in user, consistent with the rest of
  // the API. Making them public is a deliberate product decision, not a default.
  router.use(requireAuth(ctx));

  router.get(
    '/nearby',
    validateQuery(nearbyQuerySchema),
    handle(async (_req, res) => {
      const query = res.locals['query'] as NearbyQuery;
      res.json({ lots: await findNearbyLots(ctx.db, query) });
    }),
  );

  router.get(
    '/:id',
    handle(async (req, res) => {
      const id = uuidSchema.parse(req.params['id']);
      res.json(await getLot(ctx.db, id));
    }),
  );

  router.get(
    '/:id/layout',
    handle(async (req, res) => {
      const id = uuidSchema.parse(req.params['id']);
      // Spread rather than nested: the snapshot already names its lot and the
      // version those slots were read at, and the client needs all three.
      res.json(await getLotLayout(ctx.db, id));
    }),
  );

  return router;
}
