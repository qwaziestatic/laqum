import type { BookingSource, BookingStatus } from './enums.js';

/**
 * THE booking state machine. Fixed by the brief; never edit without asking.
 *
 * This table is the single authority. transition() validates every (from, to)
 * pair against it before touching the database, so no caller can widen the
 * machine by passing a generous `from` set.
 */

export type TransitionActor = 'driver' | 'attendant' | 'system' | 'job';

export interface TransitionDef {
  readonly from: BookingStatus;
  readonly to: BookingStatus;
  readonly trigger: string;
  readonly actor: TransitionActor;
}

export const TRANSITIONS: readonly TransitionDef[] = [
  {
    from: 'PENDING_PAYMENT',
    to: 'RESERVED',
    trigger: 'Deposit confirmed',
    actor: 'system',
  },
  {
    from: 'PENDING_PAYMENT',
    to: 'EXPIRED',
    trigger: 'Payment window lapses',
    actor: 'job',
  },
  {
    from: 'RESERVED',
    to: 'CHECKED_IN',
    trigger: 'Entry QR / short code scanned',
    actor: 'attendant',
  },
  {
    from: 'RESERVED',
    to: 'EXPIRED',
    trigger: 'Hold window lapses; deposit kept',
    actor: 'job',
  },
  {
    from: 'RESERVED',
    to: 'CANCELLED',
    trigger: 'Driver cancels; deposit kept',
    actor: 'driver',
  },
  {
    from: 'CHECKED_IN',
    to: 'OVERSTAY',
    trigger: 'planned_end_at passes',
    actor: 'job',
  },
  {
    from: 'CHECKED_IN',
    to: 'CHECKED_OUT',
    trigger: 'Exit scan or manual release',
    actor: 'attendant',
  },
  {
    from: 'OVERSTAY',
    to: 'CHECKED_OUT',
    trigger: 'Exit scan or manual release',
    actor: 'attendant',
  },
  {
    from: 'CHECKED_OUT',
    to: 'PAID',
    trigger: 'Final payment succeeds, cash recorded, or amount due = 0',
    actor: 'system',
  },
] as const;

/**
 * Creation is an INSERT, not a compare-and-set, so it is a separate table.
 * A booking may only be born in one of these states, and which ones depend on
 * its source.
 */
export interface CreationDef {
  readonly source: BookingSource;
  readonly to: BookingStatus;
  readonly trigger: string;
  readonly actor: TransitionActor;
}

export const CREATIONS: readonly CreationDef[] = [
  {
    source: 'app',
    to: 'PENDING_PAYMENT',
    trigger: 'Driver books; deposit > 0',
    actor: 'driver',
  },
  { source: 'app', to: 'RESERVED', trigger: 'Driver books; deposit = 0', actor: 'driver' },
  {
    source: 'walk_in',
    to: 'CHECKED_IN',
    trigger: '"Walk-in park" on a free slot',
    actor: 'attendant',
  },
] as const;

const LEGAL_PAIRS: ReadonlySet<string> = new Set(TRANSITIONS.map((t) => `${t.from}->${t.to}`));

const LEGAL_CREATIONS: ReadonlySet<string> = new Set(CREATIONS.map((c) => `${c.source}->${c.to}`));

export function isLegalTransition(from: BookingStatus, to: BookingStatus): boolean {
  return LEGAL_PAIRS.has(`${from}->${to}`);
}

/** Every status a booking may legally be in immediately before entering `to`. */
export function allowedFromFor(to: BookingStatus): BookingStatus[] {
  return TRANSITIONS.filter((t) => t.to === to).map((t) => t.from);
}

/** Every status reachable in one step from `from`. */
export function legalTargetsFrom(from: BookingStatus): BookingStatus[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.to);
}

export function isLegalCreation(source: BookingSource, to: BookingStatus): boolean {
  return LEGAL_CREATIONS.has(`${source}->${to}`);
}

/** Statuses a booking of this source may be created in. */
export function creationStatusesFor(source: BookingSource): BookingStatus[] {
  return CREATIONS.filter((c) => c.source === source).map((c) => c.to);
}
