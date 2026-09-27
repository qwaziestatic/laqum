import type { Database } from '@laqum/db';
import { type BookingStatus, type Clock, type Locale, isLocale } from '@laqum/shared';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { JobQueue, JobScheduler, ScheduledJob } from '../jobs/scheduler.js';
import { DEVICE_NOT_REGISTERED, type PushMessage, type PushProvider } from './provider.js';
import { type NotificationKind, pushText } from './texts.js';

/**
 * PUSH NOTIFICATIONS: when, to whom, and never when it is no longer true.
 *
 * The brief: expiry warnings, time reminders, overstay and "amount due".
 * The product owner (D2): BOTH a warning 5 minutes before a hold expires and
 * a notice once it has, so a driver in traffic does not arrive believing the
 * slot is still theirs.
 *
 * WHEN. Status changes are recorded by transition()/create.ts, the only
 * writers (invariant 3), and inTransaction turns each into its emit AND its
 * notification job, after the commit (invariant 5): nothing to remember at a
 * call site. The two time-based ones (the hold warning, the 10-minute
 * reminder) are delayed jobs.
 *
 * NEVER WHEN STALE. Every job RE-READS the booking and sends only if what it
 * is about is still true: a hold checked in before its warning, a stay
 * extended past its reminder, a bill already paid all send nothing
 * (invariant 6 in spirit: a stale job is a no-op).
 */

/** Warned this long before a hold is released (D2). */
export const HOLD_WARNING_MINUTES = 5;
/** Receipts are checked this long after sending, as Expo recommends. */
export const RECEIPT_CHECK_MINUTES = 15;

export const NOTIFY_QUEUE: Record<NotificationKind, JobQueue> = {
  'hold-reminder': 'hold-reminder',
  'hold-expired': 'notify-hold-expired',
  'time-reminder': 'time-reminder',
  overstay: 'notify-overstay',
  'amount-due': 'notify-amount-due',
};

/** A status change, as recorded against its transaction (afterCommit.ts). */
export interface StatusChange {
  bookingId: string | null;
  userId: string | null;
  from: BookingStatus | null;
  to: BookingStatus | null;
  at: Date;
  holdExpiresAt: Date | null;
}

/** The notification jobs a committed status change calls for. */
export function notificationJobs(change: StatusChange): ScheduledJob[] {
  const { bookingId, userId } = change;
  // Walk-ins have no app, and a slot taken out of service is not a booking.
  if (bookingId === null || userId === null) return [];
  const now = change.at;
  const jobs: ScheduledJob[] = [];

  if (change.to === 'RESERVED' && change.holdExpiresAt) {
    const warnAt = new Date(change.holdExpiresAt.getTime() - HOLD_WARNING_MINUTES * 60_000);
    // A hold shorter than the warning gets none: "5 minutes left" at once
    // would be false.
    if (warnAt.getTime() > now.getTime()) {
      jobs.push({ queue: NOTIFY_QUEUE['hold-reminder'], bookingId, runAt: warnAt });
    }
  }
  if (change.from === 'RESERVED' && change.to === 'EXPIRED') {
    jobs.push({ queue: NOTIFY_QUEUE['hold-expired'], bookingId, runAt: now });
  }
  if (change.from === 'CHECKED_IN' && change.to === 'OVERSTAY') {
    jobs.push({ queue: NOTIFY_QUEUE.overstay, bookingId, runAt: now });
  }
  if (change.to === 'CHECKED_OUT') {
    jobs.push({ queue: NOTIFY_QUEUE['amount-due'], bookingId, runAt: now });
  }
  return jobs;
}

export interface NotifyDeps {
  db: Kysely<Database>;
  clock: Clock;
  logger: Logger;
  push: PushProvider;
  redis: Redis;
  scheduler: JobScheduler;
}

export type NotifyOutcome =
  | { sent: number; reason?: undefined }
  | { sent: 0; reason: 'NOT_FOUND' | 'NO_LONGER_TRUE' | 'NO_DEVICE' };

interface BookingForNotice {
  status: BookingStatus;
  user_id: string | null;
  hold_expires_at: Date | null;
  planned_end_at: Date | null;
  amount_due_santim: number | null;
  lot_name: string;
}

/** Is what this notification says still true right now? Then what to fill in. */
function stillTrue(
  kind: NotificationKind,
  b: BookingForNotice,
  now: Date,
): { time?: Date; minutes?: number; amountSantim?: number } | null {
  const minutesUntil = (at: Date): number => Math.ceil((at.getTime() - now.getTime()) / 60_000);
  switch (kind) {
    case 'hold-reminder':
      return b.status === 'RESERVED' && b.hold_expires_at && b.hold_expires_at > now
        ? { time: b.hold_expires_at, minutes: minutesUntil(b.hold_expires_at) }
        : null;
    case 'hold-expired':
      return b.status === 'EXPIRED' ? { time: b.hold_expires_at ?? now } : null;
    case 'time-reminder':
      return b.status === 'CHECKED_IN' && b.planned_end_at && b.planned_end_at > now
        ? { time: b.planned_end_at, minutes: minutesUntil(b.planned_end_at) }
        : null;
    case 'overstay':
      return b.status === 'OVERSTAY' ? {} : null;
    case 'amount-due':
      return b.status === 'CHECKED_OUT' && (b.amount_due_santim ?? 0) > 0
        ? { amountSantim: b.amount_due_santim ?? 0 }
        : null;
  }
}

const receiptsKey = (bookingId: string): string => `push:receipts:${bookingId}`;

export async function notify(
  deps: NotifyDeps,
  kind: NotificationKind,
  bookingId: string,
): Promise<NotifyOutcome> {
  const booking = await deps.db
    .selectFrom('bookings')
    .innerJoin('lots', 'lots.id', 'bookings.lot_id')
    .select([
      'bookings.status',
      'bookings.user_id',
      'bookings.hold_expires_at',
      'bookings.planned_end_at',
      'bookings.amount_due_santim',
      'lots.name as lot_name',
    ])
    .where('bookings.id', '=', bookingId)
    .executeTakeFirst();
  if (!booking?.user_id) return { sent: 0, reason: 'NOT_FOUND' };

  const values = stillTrue(kind, booking, deps.clock.now());
  if (values === null) return { sent: 0, reason: 'NO_LONGER_TRUE' };

  const devices = await deps.db
    .selectFrom('push_tokens')
    .select(['expo_push_token', 'locale'])
    .where('user_id', '=', booking.user_id)
    .execute();
  if (devices.length === 0) return { sent: 0, reason: 'NO_DEVICE' };

  const messages: PushMessage[] = devices.map((device) => {
    const locale: Locale = isLocale(device.locale) ? device.locale : 'am';
    return {
      to: device.expo_push_token,
      ...pushText(kind, locale, { lot: booking.lot_name, ...values }),
      data: { bookingId, kind },
    };
  });

  const tickets = await deps.push.send(messages);

  // A token Expo already knows is dead is removed now; the rest are checked
  // again in RECEIPT_CHECK_MINUTES, when Expo knows what FCM said.
  const dead: string[] = [];
  const pending: { id: string; token: string }[] = [];
  tickets.forEach((ticket, i) => {
    const token = messages[i]?.to;
    if (token === undefined) return;
    if (ticket.status === 'ok') pending.push({ id: ticket.id, token });
    else if (ticket.error === DEVICE_NOT_REGISTERED) dead.push(token);
    else deps.logger.warn({ kind, error: ticket.error }, 'push not accepted');
  });
  await forgetTokens(deps, dead);

  if (pending.length > 0) {
    await deps.redis.rpush(receiptsKey(bookingId), ...pending.map((p) => JSON.stringify(p)));
    await deps.redis.expire(receiptsKey(bookingId), 24 * 60 * 60);
    await deps.scheduler.schedule({
      queue: 'push-receipts',
      bookingId,
      runAt: new Date(deps.clock.now().getTime() + RECEIPT_CHECK_MINUTES * 60_000),
    });
  }
  deps.logger.info({ kind, sent: pending.length, dead: dead.length }, 'push notification sent');
  return { sent: pending.length };
}

/** Receipts for a booking's recent tickets: forget the devices that are gone. */
export async function checkReceipts(deps: NotifyDeps, bookingId: string): Promise<number> {
  const key = receiptsKey(bookingId);
  const entries = (await deps.redis.lrange(key, 0, -1)).map(
    (raw) => JSON.parse(raw) as { id: string; token: string },
  );
  await deps.redis.del(key);
  if (entries.length === 0) return 0;

  const receipts = await deps.push.receipts(entries.map((e) => e.id));
  const dead = entries
    .filter((e) => {
      const receipt = receipts[e.id];
      return receipt?.status === 'error' && receipt.error === DEVICE_NOT_REGISTERED;
    })
    .map((e) => e.token);
  await forgetTokens(deps, dead);
  return dead.length;
}

async function forgetTokens(deps: NotifyDeps, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await deps.db.deleteFrom('push_tokens').where('expo_push_token', 'in', tokens).execute();
  deps.logger.info({ count: tokens.length }, 'forgot push tokens Expo reports as unregistered');
}
