import { AppError, recordRefundSchema, uuidSchema } from '@laqum/shared';
import { Router } from 'express';
import { currentUser, requireAuth, requireRole } from '../middleware/auth.js';
import { handle, validateBody } from '../middleware/validate.js';
import { refundQueue, type PaymentsContext } from './service.js';

/**
 * The operator's refund queue.
 *
 * Scoped to the lots the admin staffs, like every other lot-scoped endpoint —
 * an admin of one operator has no business seeing another's money.
 */

async function staffedLotIds(ctx: PaymentsContext, userId: string): Promise<string[]> {
  const rows = await ctx.db
    .selectFrom('lot_staff')
    .select('lot_id')
    .where('user_id', '=', userId)
    .execute();
  return rows.map((row) => row.lot_id);
}

export function refundsRouter(ctx: PaymentsContext): Router {
  const router = Router();
  router.use(requireAuth(ctx), requireRole('operator_admin'));

  router.get(
    '/refunds',
    handle(async (_req, res) => {
      const user = currentUser(res);
      const items = await refundQueue(ctx, { lotIds: await staffedLotIds(ctx, user.userId) });

      res.json({
        refunds: items.map((item) => ({
          paymentId: item.paymentId,
          bookingId: item.bookingId,
          lotId: item.lotId,
          txRef: item.txRef,
          kind: item.kind,
          amountSantim: item.amountSantim,
          collectedAt: item.collectedAt.toISOString(),
          bookingStatus: item.bookingStatus,
          reason: item.reason,
        })),
      });
    }),
  );

  /**
   * Record that a refund has been made.
   *
   * This does NOT call the provider: refunds are an operator-initiated
   * correction, performed in the Chapa dashboard or in cash, and this endpoint
   * records that it happened so the item leaves the queue.
   *
   * Idempotent: a second call for the same payment returns the existing refund
   * row rather than recording a duplicate.
   */
  router.post(
    '/payments/:id/refund-recorded',
    validateBody(recordRefundSchema),
    handle(async (req, res) => {
      const user = currentUser(res);
      const paymentId = uuidSchema.parse(req.params['id']);
      const body = req.body as { amountSantim?: number; reason?: string };

      const original = await ctx.db
        .selectFrom('payments as p')
        .innerJoin('bookings as b', 'b.id', 'p.booking_id')
        .innerJoin('lot_staff as ls', 'ls.lot_id', 'b.lot_id')
        .select([
          'p.id as id',
          'p.booking_id as bookingId',
          'p.amount_santim as amountSantim',
          'p.kind as kind',
          'p.status as status',
          'p.provider_payload as providerPayload',
        ])
        .where('p.id', '=', paymentId)
        .where('ls.user_id', '=', user.userId)
        .executeTakeFirst();

      if (!original) throw new AppError('NOT_FOUND', 'No such payment at a lot you staff');
      /*
       * Two shapes are refundable, and both represent money we hold:
       *   success  a late deposit, recorded normally;
       *   failed + refundOwed  an overpayment the provider collected but
       *            one_paid_final_per_booking would not let us record as a
       *            second success.
       */
      const payload = original.providerPayload as { refundOwed?: unknown } | null;
      const refundOwed = payload?.refundOwed === true;
      if (original.status !== 'success' && !refundOwed) {
        throw new AppError('PAYMENT_NOT_CONFIRMED', 'Only a collected payment can be refunded', {
          status: original.status,
        });
      }
      if (original.kind === 'refund') {
        throw new AppError('VALIDATION_ERROR', 'That row is itself a refund');
      }

      const existing = await ctx.db
        .selectFrom('payments')
        .selectAll()
        .where('booking_id', '=', original.bookingId)
        .where('kind', '=', 'refund')
        .where('status', '=', 'success')
        .executeTakeFirst();

      if (existing) {
        // Idempotent: the queue item is already gone.
        res.json({ refund: existing, alreadyRecorded: true });
        return;
      }

      const amountSantim = body.amountSantim ?? original.amountSantim;
      if (amountSantim > original.amountSantim) {
        throw new AppError('VALIDATION_ERROR', 'A refund cannot exceed what was collected', {
          collectedSantim: original.amountSantim,
          requestedSantim: amountSantim,
        });
      }

      const now = ctx.clock.now();
      const refund = await ctx.db
        .insertInto('payments')
        .values({
          booking_id: original.bookingId,
          kind: 'refund',
          // Recorded by a person, so the schema's cash_has_recorder applies
          // and recorded_by is required — which is the point: a refund always
          // has a named operator behind it.
          provider: 'cash',
          amount_santim: amountSantim,
          status: 'success',
          recorded_by: user.userId,
          provider_payload: JSON.stringify({
            refundOf: paymentId,
            reason: body.reason ?? null,
            note: 'recorded by an operator; Chapa fees are non-refundable',
          }),
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      ctx.logger.info(
        { paymentId, bookingId: original.bookingId, amountSantim, by: user.userId },
        'operator recorded a refund',
      );

      res.status(201).json({ refund, alreadyRecorded: false });
    }),
  );

  return router;
}
