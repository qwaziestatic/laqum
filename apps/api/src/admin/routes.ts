import {
  AppError,
  bulkSlotsSchema,
  createLotSchema,
  updateLotSchema,
  uuidSchema,
} from '@laqum/shared';
import { Router } from 'express';
import { inTransaction } from '../afterCommit.js';
import type { AppContext } from '../context.js';
import { CONSTRAINTS, isUniqueViolation } from '../db/pgError.js';
import { currentUser, requireAuth, requireLotStaff, requireRole } from '../middleware/auth.js';
import { handle, validateBody } from '../middleware/validate.js';

interface CreateLotBody {
  operatorId: string;
  name: string;
  address?: string;
  latitude: number;
  longitude: number;
  contactPhone: string;
  blockMinutes: number;
  ratePerBlockSantim: number;
  overstayRatePerBlockSantim: number;
  depositAmountSantim: number;
  paymentWindowMinutes: number;
  holdMinutes: number;
  maxBookingDistanceM: number;
}

export function adminRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx), requireRole('operator_admin'));

  router.post(
    '/lots',
    validateBody(createLotSchema),
    handle(async (req, res) => {
      const user = currentUser(res);
      const body = req.body as CreateLotBody;

      const operator = await ctx.db
        .selectFrom('operators')
        .select('id')
        .where('id', '=', body.operatorId)
        .executeTakeFirst();
      if (!operator) throw new AppError('NOT_FOUND', 'No such operator');

      const lot = await inTransaction(ctx.db, ctx.logger, async (trx) => {
        const created = await trx
          .insertInto('lots')
          .values({
            operator_id: body.operatorId,
            name: body.name,
            address: body.address ?? null,
            latitude: body.latitude,
            longitude: body.longitude,
            contact_phone: body.contactPhone,
            block_minutes: body.blockMinutes,
            rate_per_block_santim: body.ratePerBlockSantim,
            overstay_rate_per_block_santim: body.overstayRatePerBlockSantim,
            deposit_amount_santim: body.depositAmountSantim,
            payment_window_minutes: body.paymentWindowMinutes,
            hold_minutes: body.holdMinutes,
            max_booking_distance_m: body.maxBookingDistanceM,
            created_at: ctx.clock.now(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        // The creating admin staffs the lot, otherwise they could not manage
        // the thing they just created: every lot-scoped endpoint checks
        // lot_staff membership, admins included.
        await trx
          .insertInto('lot_staff')
          .values({ lot_id: created.id, user_id: user.userId })
          .execute();

        return created;
      });

      res.status(201).json({ lot });
    }),
  );

  router.patch(
    '/lots/:id',
    requireLotStaff(ctx, 'id'),
    validateBody(updateLotSchema),
    handle(async (req, res) => {
      const lotId = uuidSchema.parse(req.params['id']);
      const body = req.body as Partial<CreateLotBody>;

      const patch = {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.address === undefined ? {} : { address: body.address }),
        ...(body.latitude === undefined ? {} : { latitude: body.latitude }),
        ...(body.longitude === undefined ? {} : { longitude: body.longitude }),
        ...(body.contactPhone === undefined ? {} : { contact_phone: body.contactPhone }),
        ...(body.blockMinutes === undefined ? {} : { block_minutes: body.blockMinutes }),
        ...(body.ratePerBlockSantim === undefined
          ? {}
          : { rate_per_block_santim: body.ratePerBlockSantim }),
        ...(body.overstayRatePerBlockSantim === undefined
          ? {}
          : { overstay_rate_per_block_santim: body.overstayRatePerBlockSantim }),
        ...(body.depositAmountSantim === undefined
          ? {}
          : { deposit_amount_santim: body.depositAmountSantim }),
        ...(body.paymentWindowMinutes === undefined
          ? {}
          : { payment_window_minutes: body.paymentWindowMinutes }),
        ...(body.holdMinutes === undefined ? {} : { hold_minutes: body.holdMinutes }),
        ...(body.maxBookingDistanceM === undefined
          ? {}
          : { max_booking_distance_m: body.maxBookingDistanceM }),
      };

      const lot = await ctx.db
        .updateTable('lots')
        .set(patch)
        .where('id', '=', lotId)
        .returningAll()
        .executeTakeFirst();

      if (!lot) throw new AppError('NOT_FOUND', 'No such lot');
      res.json({ lot });
    }),
  );

  router.post(
    '/lots/:id/slots/bulk',
    requireLotStaff(ctx, 'id'),
    validateBody(bulkSlotsSchema),
    handle(async (req, res) => {
      const lotId = uuidSchema.parse(req.params['id']);
      const body = req.body as {
        zone: string;
        rows: number;
        cols: number;
        labelPrefix: string;
        appBookable: boolean;
      };

      const base = body.labelPrefix.charCodeAt(0);
      const values = [];
      for (let row = 0; row < body.rows; row++) {
        for (let col = 0; col < body.cols; col++) {
          values.push({
            lot_id: lotId,
            label: `${String.fromCharCode(base + row)}-${String(col + 1)}`,
            zone: body.zone,
            grid_row: row,
            grid_col: col,
            app_bookable: body.appBookable,
          });
        }
      }

      try {
        const slots = await ctx.db.insertInto('slots').values(values).returningAll().execute();
        res.status(201).json({ created: slots.length, slots });
      } catch (err) {
        // UNIQUE (lot_id, label) and UNIQUE (lot_id, zone, grid_row, grid_col):
        // generating a grid that overlaps an existing one is a mistake, not a
        // merge.
        if (isUniqueViolation(err) && !isUniqueViolation(err, CONSTRAINTS.liveBookingPerSlot)) {
          throw new AppError('VALIDATION_ERROR', 'That grid overlaps slots this lot already has', {
            zone: body.zone,
            labelPrefix: body.labelPrefix,
          });
        }
        throw err;
      }
    }),
  );

  return router;
}
