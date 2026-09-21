import { AppError, type UserRole } from '@laqum/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppContext } from '../context.js';
import { verifyAccessToken } from '../auth/tokens.js';

/**
 * Authentication and authorisation.
 *
 * Staff endpoints check lot_staff membership for the SPECIFIC lot, not just
 * the role: an attendant at one lot has no business at another.
 */

export interface AuthenticatedUser {
  userId: string;
  role: UserRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      user?: AuthenticatedUser;
    }
  }
}

export function currentUser(res: Response): AuthenticatedUser {
  const user = res.locals.user;
  if (!user) {
    throw new AppError('UNAUTHENTICATED', 'This endpoint requires a signed-in user');
  }
  return user;
}

function bearerToken(req: Request): string {
  const header = req.get('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) {
    throw new AppError('UNAUTHENTICATED', 'Missing bearer token');
  }
  const token = header.slice('bearer '.length).trim();
  if (token.length === 0) {
    throw new AppError('UNAUTHENTICATED', 'Missing bearer token');
  }
  return token;
}

export function requireAuth(ctx: AppContext): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    verifyAccessToken(ctx.config, ctx.clock, bearerToken(req))
      .then((claims) => {
        res.locals.user = claims;
        next();
      })
      .catch(next);
  };
}

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (_req, res, next) => {
    try {
      const user = currentUser(res);
      if (!roles.includes(user.role)) {
        throw new AppError('FORBIDDEN', `This endpoint requires one of: ${roles.join(', ')}`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Membership of the lot named by `paramName`.
 *
 * operator_admin is NOT exempt: admins are scoped to the lots they staff, so
 * being an admin of one operator grants nothing at another's lot.
 */
export function requireLotStaff(ctx: AppContext, paramName = 'id'): RequestHandler {
  return (req, res, next) => {
    void (async (): Promise<void> => {
      const user = currentUser(res);
      const lotId = req.params[paramName];
      if (typeof lotId !== 'string' || lotId.length === 0) {
        throw new AppError('VALIDATION_ERROR', `Missing lot id in :${paramName}`);
      }

      const membership = await ctx.db
        .selectFrom('lot_staff')
        .select('lot_id')
        .where('lot_id', '=', lotId)
        .where('user_id', '=', user.userId)
        .executeTakeFirst();

      if (!membership) {
        throw new AppError('FORBIDDEN', 'You are not assigned to this lot');
      }
    })().then(next, next);
  };
}

/** Membership of the lot a booking belongs to. */
export async function assertStaffsBookingLot(
  ctx: AppContext,
  userId: string,
  bookingId: string,
): Promise<{ lotId: string }> {
  const row = await ctx.db
    .selectFrom('bookings')
    .innerJoin('lot_staff', 'lot_staff.lot_id', 'bookings.lot_id')
    .select('bookings.lot_id')
    .where('bookings.id', '=', bookingId)
    .where('lot_staff.user_id', '=', userId)
    .executeTakeFirst();

  if (!row) {
    // Deliberately indistinguishable from "no such booking": an attendant at
    // another lot must not be able to probe for booking ids.
    throw new AppError('NOT_FOUND', 'No such booking at a lot you staff');
  }
  return { lotId: row.lot_id };
}
