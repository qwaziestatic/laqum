import { createBookingSchema, extendBookingSchema, uuidSchema } from '@laqum/shared';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { currentUser, requireAuth, requireRole } from '../middleware/auth.js';
import { handle, validateBody } from '../middleware/validate.js';
import { createBooking } from './create.js';
import { toBookingDto } from './dto.js';
import { cancelBooking, currentBooking, extendBooking, ownedBooking } from './service.js';

export function bookingsRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx), requireRole('driver', 'attendant', 'operator_admin'));

  router.post(
    '/',
    validateBody(createBookingSchema),
    handle(async (req, res) => {
      const user = currentUser(res);
      const body = req.body as {
        lotId: string;
        plannedMinutes: number;
        vehiclePlate?: string;
        lat: number;
        lng: number;
      };

      const result = await createBooking(
        { db: ctx.db, clock: ctx.clock, logger: ctx.logger, scheduler: ctx.scheduler },
        {
          lotId: body.lotId,
          userId: user.userId,
          plannedMinutes: body.plannedMinutes,
          vehiclePlate: body.vehiclePlate ?? null,
          latitude: body.lat,
          longitude: body.lng,
        },
      );

      res.status(201).json({
        booking: toBookingDto(result.booking),
        paymentRequired: result.paymentRequired,
        depositAmountSantim: result.lot.deposit_amount_santim,
        // Filled in by Phase 2, when a payment provider exists. Until then a
        // deposit booking sits in PENDING_PAYMENT until its window lapses.
        checkoutUrl: null,
      });
    }),
  );

  router.get(
    '/current',
    handle(async (_req, res) => {
      const user = currentUser(res);
      const booking = await currentBooking(ctx, user.userId);
      // 200 with null rather than 404: "you have no booking" is a normal
      // answer, not a failed request.
      res.json({ booking: booking ? toBookingDto(booking) : null });
    }),
  );

  router.get(
    '/:id',
    handle(async (req, res) => {
      const user = currentUser(res);
      const id = uuidSchema.parse(req.params['id']);
      res.json({ booking: toBookingDto(await ownedBooking(ctx, user.userId, id)) });
    }),
  );

  router.post(
    '/:id/cancel',
    handle(async (req, res) => {
      const user = currentUser(res);
      const id = uuidSchema.parse(req.params['id']);
      res.json({ booking: toBookingDto(await cancelBooking(ctx, user.userId, id)) });
    }),
  );

  router.post(
    '/:id/extend',
    validateBody(extendBookingSchema),
    handle(async (req, res) => {
      const user = currentUser(res);
      const id = uuidSchema.parse(req.params['id']);
      const { additionalBlocks } = req.body as { additionalBlocks: number };

      const result = await extendBooking(ctx, user.userId, id, additionalBlocks);
      res.json({
        booking: toBookingDto(result.booking),
        addedMinutes: result.addedMinutes,
      });
    }),
  );

  return router;
}
