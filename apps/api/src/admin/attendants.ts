import { AppError, type Attendant } from '@laqum/shared';
import type { AppContext } from '../context.js';

/**
 * ATTENDANTS ON A LOT, managed by the lot's operator admin.
 *
 * Adding makes a number an attendant of this lot: a new number becomes an
 * attendant account; an attendant of another lot is added here too. A
 * number that belongs to a DRIVER or an ADMIN is refused: silently changing
 * what an existing account can do is not "adding an attendant", and a
 * driver's bookings would sit under a staff account.
 *
 * Removing takes the attendant off this lot, effective at once everywhere:
 * the HTTP staff endpoints re-check lot_staff on every request, and the
 * attendant's open sockets are taken out of the lot's staff room, which a
 * socket would otherwise keep until its token expired ("Socket authorization
 * must not outlive its basis", CLAUDE.md). A re-subscribe is refused by the
 * same lot_staff check.
 */

type Deps = Pick<AppContext, 'db' | 'clock' | 'emitter'>;

export async function listAttendants(deps: Deps, lotId: string): Promise<Attendant[]> {
  const rows = await deps.db
    .selectFrom('lot_staff')
    .innerJoin('users', 'users.id', 'lot_staff.user_id')
    .select(['users.id', 'users.phone', 'users.full_name'])
    .where('lot_staff.lot_id', '=', lotId)
    .where('users.role', '=', 'attendant')
    .orderBy('users.phone')
    .execute();
  return rows.map((r) => ({ userId: r.id, phone: r.phone, fullName: r.full_name }));
}

/** `added` is false when the number was already an attendant of this lot. */
export async function addAttendant(
  deps: Deps,
  lotId: string,
  input: { phone: string; fullName?: string | undefined },
): Promise<{ attendant: Attendant; added: boolean }> {
  return deps.db.transaction().execute(async (trx) => {
    // Created if new; a concurrent add of the same number meets the UNIQUE
    // phone and reads the other's row instead of failing.
    await trx
      .insertInto('users')
      .values({ phone: input.phone, role: 'attendant', full_name: input.fullName ?? null })
      .onConflict((oc) => oc.column('phone').doNothing())
      .execute();
    const user = await trx
      .selectFrom('users')
      .select(['id', 'phone', 'full_name', 'role'])
      .where('phone', '=', input.phone)
      .executeTakeFirstOrThrow();

    if (user.role !== 'attendant') {
      throw new AppError(
        'STATE_CONFLICT',
        `That number belongs to ${user.role === 'driver' ? 'a driver' : 'an admin'} account, which cannot be made an attendant here`,
      );
    }

    const inserted = await trx
      .insertInto('lot_staff')
      .values({ lot_id: lotId, user_id: user.id })
      .onConflict((oc) => oc.columns(['lot_id', 'user_id']).doNothing())
      .returning('user_id')
      .executeTakeFirst();

    return {
      attendant: { userId: user.id, phone: user.phone, fullName: user.full_name },
      added: inserted !== undefined,
    };
  });
}

/** Only an ATTENDANT of this lot: an admin cannot be removed this way. */
export async function removeAttendant(deps: Deps, lotId: string, userId: string): Promise<void> {
  const removed = await deps.db
    .deleteFrom('lot_staff')
    .where('lot_id', '=', lotId)
    .where('user_id', '=', userId)
    .where('user_id', 'in', (qb) =>
      qb.selectFrom('users').select('id').where('role', '=', 'attendant'),
    )
    .returning('user_id')
    .executeTakeFirst();
  if (!removed) throw new AppError('NOT_FOUND', 'No such attendant on this lot');

  // After the delete has committed (a single statement): invariant 5.
  deps.emitter.staffRemoved(lotId, userId);
}
