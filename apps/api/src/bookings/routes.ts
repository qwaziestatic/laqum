import {
  AppError,
  type BookingResponse,
  type CancelBookingResponse,
  type CreateBookingRequest,
  type CreateBookingResponse,
  type CurrentBookingResponse,
  type ExtendBookingRequest,
  type ExtendBookingResponse,
  type PayBookingResponse,
  createBookingSchema,
  extendBookingSchema,
  uuidSchema,
} from '@laqum/shared';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { currentUser, requireAuth, requireRole } from '../middleware/auth.js';
import { handle, validateBody } from '../middleware/validate.js';
import { createBooking } from './create.js';
import { toBookingDto } from './dto.js';
import { cancelBooking, currentBooking, extendBooking, ownedBooking } from './service.js';
import { initiatePayment } from '../payments/initiate.js';
import { confirmPayment, paymentNoticeFor } from '../payments/service.js';

export function bookingsRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx), requireRole('driver', 'attendant', 'operator_admin'));

  router.post(
    '/',
    validateBody(createBookingSchema),
    handle(async (req, res) => {
      const user = currentUser(res);
      // Validated by createBookingSchema above.
      const body = req.body as CreateBookingRequest;

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
        // Nothing initiates a deposit payment yet, so a deposit booking sits
        // in PENDING_PAYMENT until its window lapses. See createBookingResponseSchema.
        checkoutUrl: null,
      } satisfies CreateBookingResponse);
    }),
  );

  router.get(
    '/current',
    handle(async (_req, res) => {
      const user = currentUser(res);
      const booking = await currentBooking(ctx, user.userId);
      // 200 with null rather than 404: "you have no booking" is a normal
      // answer, not a failed request.
      res.json({
        booking: booking ? toBookingDto(booking) : null,
        paymentNotice: booking ? await paymentNoticeFor(ctx, booking.id) : null,
      } satisfies CurrentBookingResponse);
    }),
  );

  router.get(
    '/:id',
    handle(async (req, res) => {
      const user = currentUser(res);
      const id = uuidSchema.parse(req.params['id']);
      const booking = await ownedBooking(ctx, user.userId, id);
      res.json({
        booking: toBookingDto(booking),
        paymentNotice: await paymentNoticeFor(ctx, booking.id),
      } satisfies BookingResponse);
    }),
  );

  router.post(
    '/:id/cancel',
    handle(async (req, res) => {
      const user = currentUser(res);
      const id = uuidSchema.parse(req.params['id']);
      res.json({
        booking: toBookingDto(await cancelBooking(ctx, user.userId, id)),
      } satisfies CancelBookingResponse);
    }),
  );

  router.post(
    '/:id/extend',
    validateBody(extendBookingSchema),
    handle(async (req, res) => {
      const user = currentUser(res);
      const id = uuidSchema.parse(req.params['id']);
      const { additionalBlocks } = req.body as ExtendBookingRequest;

      const result = await extendBooking(ctx, user.userId, id, additionalBlocks);
      res.json({
        booking: toBookingDto(result.booking),
        addedMinutes: result.addedMinutes,
      } satisfies ExtendBookingResponse);
    }),
  );

  /**
   * Pay the final bill in the app.
   *
   * Reuses an existing pending payment rather than creating a second one: two
   * live references for one bill is how a driver ends up charged twice.
   */
  router.post(
    '/:id/pay',
    handle(async (req, res) => {
      const user = currentUser(res);
      const id = uuidSchema.parse(req.params['id']);
      const booking = await ownedBooking(ctx, user.userId, id);

      if (booking.status === 'PAID') {
        throw new AppError('ALREADY_PAID', 'This booking is already settled');
      }
      if (booking.status !== 'CHECKED_OUT') {
        throw new AppError('STATE_CONFLICT', 'There is nothing to pay for yet', {
          status: booking.status,
        });
      }

      const amountSantim = booking.amount_due_santim ?? 0;
      if (amountSantim <= 0) {
        throw new AppError('ALREADY_PAID', 'Nothing is owed on this booking');
      }

      const existing = await ctx.db
        .selectFrom('payments')
        .selectAll()
        .where('booking_id', '=', id)
        .where('kind', '=', 'final')
        .where('status', '=', 'pending')
        .where('tx_ref', 'is not', null)
        .executeTakeFirst();

      if (existing?.tx_ref) {
        const outcome = await confirmPayment(ctx, existing.tx_ref);
        if (outcome.kind === 'confirmed' || outcome.kind === 'already_settled') {
          throw new AppError('ALREADY_PAID', 'This booking is already settled');
        }
      }

      const initiated = await initiatePayment(ctx, {
        bookingId: id,
        kind: 'final',
        amountSantim,
        description: 'ላቁም? parking',
      });

      res.status(201).json({
        checkoutUrl: initiated.checkoutUrl,
        txRef: initiated.payment.tx_ref,
        amountSantim,
      } satisfies PayBookingResponse);
    }),
  );

  return router;
}
