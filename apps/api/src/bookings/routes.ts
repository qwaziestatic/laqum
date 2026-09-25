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
  type PayDepositResponse,
  createBookingSchema,
  extendBookingSchema,
  isAppError,
  uuidSchema,
} from '@laqum/shared';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { currentUser, requireAuth, requireRole } from '../middleware/auth.js';
import { handle, validateBody } from '../middleware/validate.js';
import { createBooking } from './create.js';
import { toBookingDto } from './dto.js';
import { cancelBooking, currentBooking, extendBooking, ownedBooking } from './service.js';
import { checkDeposits, openDeposit, startDeposit } from '../payments/deposit.js';
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

      /*
       * The deposit starts AFTER the booking commits (invariant 5: a provider
       * call is a side effect). If the provider cannot be reached, the booking
       * still stands in PENDING_PAYMENT with no checkout: the driver retries
       * with POST /:id/deposit, and with no initialized payment the booking
       * expires exactly at its payment window (see checkDeposits).
       */
      let checkoutUrl: string | null = null;
      if (result.paymentRequired) {
        try {
          const started = await startDeposit(
            ctx,
            result.booking.id,
            result.lot.deposit_amount_santim,
          );
          checkoutUrl = started.checkoutUrl;
        } catch (err) {
          if (!isAppError(err) || err.code !== 'PROVIDER_UNAVAILABLE') throw err;
          ctx.logger.warn(
            { bookingId: result.booking.id },
            'deposit not started: the payment provider is unreachable; the driver can retry',
          );
        }
      }

      res.status(201).json({
        booking: toBookingDto(result.booking),
        paymentRequired: result.paymentRequired,
        depositAmountSantim: result.lot.deposit_amount_santim,
        checkoutUrl,
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
        lotVersion: booking?.lot_version ?? null,
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
        lotVersion: booking.lot_version,
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
   * Pay the deposit: reopen the payable checkout, or start one. Also the
   * retry after the provider was unreachable at booking time.
   */
  router.post(
    '/:id/deposit',
    handle(async (req, res) => {
      const user = currentUser(res);
      const id = uuidSchema.parse(req.params['id']);
      const opened = await openDeposit(ctx, await ownedBooking(ctx, user.userId, id));

      res.status(opened.reused ? 200 : 201).json({
        checkoutUrl: opened.checkoutUrl,
        txRef: opened.txRef,
        amountSantim: opened.amountSantim,
      } satisfies PayDepositResponse);
    }),
  );

  /**
   * Ask the provider now, rather than waiting for the webhook.
   *
   * The app calls this when the driver returns from the checkout, which is
   * usually seconds before the webhook lands. Never starts a payment.
   * PROVIDER_UNAVAILABLE (503) when the provider cannot be asked.
   */
  router.post(
    '/:id/deposit/verify',
    handle(async (req, res) => {
      const user = currentUser(res);
      const id = uuidSchema.parse(req.params['id']);
      const booking = await ownedBooking(ctx, user.userId, id);
      if (booking.status === 'PENDING_PAYMENT') await checkDeposits(ctx, id);

      // Re-read: a confirmed deposit has just moved it to RESERVED.
      const current = await ownedBooking(ctx, user.userId, id);
      res.json({
        booking: toBookingDto(current),
        paymentNotice: await paymentNoticeFor(ctx, id),
        lotVersion: current.lot_version,
      } satisfies BookingResponse);
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
