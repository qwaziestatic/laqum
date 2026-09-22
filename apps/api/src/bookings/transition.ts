import type { Database } from '@laqum/db';
import { AppError, type BookingStatus, type Clock, isLegalTransition } from '@laqum/shared';
import type { Kysely, Selectable, Transaction, Updateable } from 'kysely';

/**
 * THE state-change function. INVARIANT 3.
 *
 * This file and create.ts are the ONLY places that write bookings.status.
 * apps/api/test/guards.test.ts greps for violations.
 */

export type BookingRow = Selectable<Database['bookings']>;

/**
 * A patch may never carry `status`: that is what this function is for. Making
 * it a type error means the invariant is enforced by the compiler, not by
 * review.
 */
export type BookingPatch = Omit<Updateable<Database['bookings']>, 'status' | 'id' | 'updated_at'>;

/**
 * Jobs must be guarded by TIME as well as by status.
 *
 * A status CAS alone is not enough for a delayed job. Consider an extension: a
 * booking is CHECKED_IN with planned_end_at at 09:00, a mark-overstay job is
 * queued for 09:00, then the driver extends to 10:00. The stale 09:00 job
 * still finds the booking CHECKED_IN, so the status check passes and the car
 * is marked OVERSTAY an hour early.
 *
 * So job handlers additionally require the deadline to have actually passed,
 * evaluated against the injected clock.
 */
export interface DueGuard {
  column: 'planned_end_at' | 'hold_expires_at';
  /** Require `column IS NOT NULL AND column <= notAfter`. */
  notAfter: Date;
}

export interface TransitionInput {
  bookingId: string;
  /** Expected current status(es). Validated against the state machine table. */
  from: BookingStatus | readonly BookingStatus[];
  to: BookingStatus;
  /** Null means a system actor: a job or a payment webhook. */
  actorId: string | null;
  patch?: BookingPatch;
  note?: string | null;
  due?: DueGuard;
}

export type TransitionOutcome =
  | { ok: true; booking: BookingRow; from: BookingStatus; lotVersion: number }
  | { ok: false; reason: 'NOT_FOUND' }
  | { ok: false; reason: 'WRONG_STATUS'; current: BookingStatus }
  | { ok: false; reason: 'NOT_DUE'; current: BookingStatus; dueAt: Date | null };

function asArray(from: BookingStatus | readonly BookingStatus[]): BookingStatus[] {
  // typeof rather than Array.isArray: the latter widens a readonly array to
  // any[], which loses the BookingStatus element type.
  return typeof from === 'string' ? [from] : [...from];
}

/**
 * Attempt a transition. Returns an outcome rather than throwing for the
 * expected failures, because a job that finds the booking already moved on is
 * a no-op, not an error. HTTP callers use transitionOrThrow.
 */
export async function transition(
  trx: Transaction<Database>,
  clock: Clock,
  input: TransitionInput,
): Promise<TransitionOutcome> {
  const allowedFrom = asArray(input.from);

  // The table is the authority. A caller cannot widen the state machine by
  // passing a generous `from`. An illegal pair is a programming error and
  // always throws, even here.
  if (allowedFrom.length === 0) {
    throw new AppError('ILLEGAL_TRANSITION', `No 'from' status given for -> ${input.to}`);
  }
  for (const from of allowedFrom) {
    if (!isLegalTransition(from, input.to)) {
      throw new AppError(
        'ILLEGAL_TRANSITION',
        `${from} -> ${input.to} is not in the state machine`,
      );
    }
  }

  const now = clock.now();

  /*
   * Lock and RE-READ the row before deciding anything.
   *
   * The tempting one-statement form is:
   *   UPDATE bookings b SET ... FROM bookings old
   *    WHERE old.id = b.id AND b.id = $id AND b.status = ANY($from)
   *   RETURNING b.*, old.status AS prev_status
   *
   * It is WRONG under READ COMMITTED. When the UPDATE blocks on a concurrent
   * writer and that writer commits, Postgres re-evaluates the target row
   * against its newest version, but the joined `old` row is still the original
   * snapshot. So: mark-overstay commits CHECKED_IN -> OVERSTAY while a
   * checkout from [CHECKED_IN, OVERSTAY] waits; the checkout then succeeds but
   * records from_status = CHECKED_IN, and the audit trail lies.
   *
   * SELECT ... FOR UPDATE blocks on the same lock, and on acquiring it reads
   * the LATEST committed version, so prev_status is accurate.
   */
  const locked = await trx
    .selectFrom('bookings')
    .selectAll()
    .where('id', '=', input.bookingId)
    .forUpdate()
    .executeTakeFirst();

  if (!locked) {
    return { ok: false, reason: 'NOT_FOUND' };
  }

  const current = locked.status;
  if (!allowedFrom.includes(current)) {
    return { ok: false, reason: 'WRONG_STATUS', current };
  }

  if (input.due) {
    const dueAt = locked[input.due.column];
    if (dueAt === null || dueAt.getTime() > input.due.notAfter.getTime()) {
      return { ok: false, reason: 'NOT_DUE', current, dueAt };
    }
  }

  /*
   * The compare-and-set. We hold the row lock, so this cannot miss — but the
   * brief specifies a CAS and it costs nothing, so it stays as defence in
   * depth against a future path that reaches here without the lock.
   */
  let update = trx
    .updateTable('bookings')
    .set({ ...(input.patch ?? {}), status: input.to, updated_at: now })
    .where('id', '=', input.bookingId)
    .where('status', 'in', allowedFrom);

  if (input.due) {
    update = update.where(input.due.column, '<=', input.due.notAfter);
  }

  const updated = await update.returningAll().executeTakeFirst();

  if (!updated) {
    // Unreachable while the lock is held; a race that defeats it is a bug, not
    // a user error, so it surfaces loudly rather than as a silent no-op.
    throw new AppError(
      'STATE_CONFLICT',
      `Compare-and-set matched no rows for booking ${input.bookingId} despite holding its lock`,
    );
  }

  // Same transaction as the status change: the audit trail cannot diverge
  // from the booking. `at` comes from the clock, not the database's now().
  await trx
    .insertInto('booking_events')
    .values({
      booking_id: input.bookingId,
      from_status: current,
      to_status: input.to,
      actor_id: input.actorId,
      note: input.note ?? null,
      at: now,
    })
    .execute();

  const lotVersion = await bumpLotVersion(trx, updated.lot_id);

  return { ok: true, booking: updated, from: current, lotVersion };
}

/**
 * The realtime ordering token. See migration 003 for why it exists instead of
 * comparing updated_at.
 *
 * Incremented in the SAME transaction as the status change, so the row lock on
 * lots serialises concurrent changes to a lot and versions come out in COMMIT
 * order rather than clock order.
 *
 * ALWAYS ACQUIRED LAST. Every write path takes its booking or slot lock first
 * and this one second, so the lock order is identical everywhere and no cycle
 * — hence no deadlock — is possible. Moving this earlier in any caller would
 * break that property.
 */
export async function bumpLotVersion(trx: Transaction<Database>, lotId: string): Promise<number> {
  const row = await trx
    .updateTable('lots')
    .set((eb) => ({ version: eb('version', '+', 1) }))
    .where('id', '=', lotId)
    .returning('version')
    .executeTakeFirstOrThrow();
  return row.version;
}

/** The lot's current version, for pairing with a snapshot. */
export async function currentLotVersion(db: Kysely<Database>, lotId: string): Promise<number> {
  const row = await db
    .selectFrom('lots')
    .select('version')
    .where('id', '=', lotId)
    .executeTakeFirst();
  return row?.version ?? 0;
}

/** transition() for HTTP paths, where a refused transition is a 4xx. */
export async function transitionOrThrow(
  trx: Transaction<Database>,
  clock: Clock,
  input: TransitionInput,
): Promise<BookingRow> {
  const outcome = await transition(trx, clock, input);
  if (outcome.ok) return outcome.booking;

  if (outcome.reason === 'NOT_FOUND') {
    throw new AppError('NOT_FOUND', `Booking ${input.bookingId} does not exist`);
  }
  if (outcome.reason === 'NOT_DUE') {
    throw new AppError(
      'STATE_CONFLICT',
      `Booking ${input.bookingId} is not due: ${input.due?.column ?? 'deadline'} has not passed`,
    );
  }
  throw new AppError(
    'STATE_CONFLICT',
    `Booking ${input.bookingId} is ${outcome.current}, expected one of ${asArray(input.from).join(', ')}`,
  );
}
