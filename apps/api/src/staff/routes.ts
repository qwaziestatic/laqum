import {
  cashPaymentSchema,
  checkInSchema,
  slotServiceSchema,
  uuidSchema,
  walkInSchema,
} from '@laqum/shared';
import { Router } from 'express';
import { toStaffBookingDto } from '../bookings/dto.js';
import type { AppContext } from '../context.js';
import {
  assertStaffsBookingLot,
  currentUser,
  requireAuth,
  requireLotStaff,
  requireRole,
} from '../middleware/auth.js';
import { handle, validateBody } from '../middleware/validate.js';
import {
  checkIn,
  checkOut,
  listLotSlots,
  listStaffedLots,
  parkWalkIn,
  recordCash,
  setSlotService,
} from './service.js';

export function staffRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx), requireRole('attendant', 'operator_admin'));

  router.get(
    '/lots',
    handle(async (_req, res) => {
      const user = currentUser(res);
      res.json({ lots: await listStaffedLots(ctx, user.userId) });
    }),
  );

  router.get(
    '/lots/:id/slots',
    requireLotStaff(ctx, 'id'),
    handle(async (req, res) => {
      const lotId = uuidSchema.parse(req.params['id']);
      res.json({ slots: await listLotSlots(ctx, lotId) });
    }),
  );

  router.post(
    '/lots/:id/walk-ins',
    requireLotStaff(ctx, 'id'),
    validateBody(walkInSchema),
    handle(async (req, res) => {
      const user = currentUser(res);
      const lotId = uuidSchema.parse(req.params['id']);
      const body = req.body as { slotId: string; vehiclePlate?: string };

      const booking = await parkWalkIn(ctx, user.userId, lotId, {
        slotId: body.slotId,
        vehiclePlate: body.vehiclePlate ?? null,
      });
      res.status(201).json({ booking: toStaffBookingDto(booking) });
    }),
  );

  router.post(
    '/check-in',
    validateBody(checkInSchema),
    handle(async (req, res) => {
      const user = currentUser(res);
      const { code } = req.body as { code: string };
      const booking = await checkIn(ctx, user.userId, code);
      res.json({ booking: toStaffBookingDto(booking) });
    }),
  );

  router.post(
    '/bookings/:id/check-out',
    handle(async (req, res) => {
      const user = currentUser(res);
      const bookingId = uuidSchema.parse(req.params['id']);
      await assertStaffsBookingLot(ctx, user.userId, bookingId);

      const result = await checkOut(ctx, user.userId, bookingId);
      res.json({
        booking: toStaffBookingDto(result.booking),
        bill: result.bill,
        settled: result.settled,
      });
    }),
  );

  router.post(
    '/bookings/:id/cash',
    validateBody(cashPaymentSchema),
    handle(async (req, res) => {
      const user = currentUser(res);
      const bookingId = uuidSchema.parse(req.params['id']);
      await assertStaffsBookingLot(ctx, user.userId, bookingId);

      const { amountSantim, overridePending } = req.body as {
        amountSantim: number;
        overridePending: boolean;
      };
      const booking = await recordCash(ctx, user.userId, bookingId, amountSantim, {
        overridePending,
      });
      res.json({ booking: toStaffBookingDto(booking) });
    }),
  );

  router.patch(
    '/slots/:id',
    validateBody(slotServiceSchema),
    handle(async (req, res) => {
      const user = currentUser(res);
      const slotId = uuidSchema.parse(req.params['id']);

      // Slot ids are not lot ids, so membership is checked through the slot.
      const slot = await ctx.db
        .selectFrom('slots')
        .innerJoin('lot_staff', 'lot_staff.lot_id', 'slots.lot_id')
        .select('slots.id')
        .where('slots.id', '=', slotId)
        .where('lot_staff.user_id', '=', user.userId)
        .executeTakeFirst();

      if (!slot) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'No such slot at a lot you staff' },
        });
        return;
      }

      const { inService } = req.body as { inService: boolean };
      res.json(await setSlotService(ctx, slotId, inService));
    }),
  );

  return router;
}
