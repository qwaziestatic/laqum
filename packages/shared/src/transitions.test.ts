import { describe, expect, it } from 'vitest';
import { BOOKING_SOURCES, BOOKING_STATUSES, LIVE_STATUSES } from './enums.js';
import {
  CREATIONS,
  TRANSITIONS,
  allowedFromFor,
  creationStatusesFor,
  isLegalCreation,
  isLegalTransition,
  legalTargetsFrom,
} from './transitions.js';

/** Exactly the nine pairs in the brief's table. Written out, not derived. */
const LEGAL: readonly (readonly [string, string])[] = [
  ['PENDING_PAYMENT', 'RESERVED'],
  ['PENDING_PAYMENT', 'EXPIRED'],
  ['RESERVED', 'CHECKED_IN'],
  ['RESERVED', 'EXPIRED'],
  ['RESERVED', 'CANCELLED'],
  ['CHECKED_IN', 'OVERSTAY'],
  ['CHECKED_IN', 'CHECKED_OUT'],
  ['OVERSTAY', 'CHECKED_OUT'],
  ['CHECKED_OUT', 'PAID'],
];

describe('the state machine table', () => {
  it('contains exactly the nine transitions in the brief', () => {
    expect(TRANSITIONS).toHaveLength(LEGAL.length);
    const actual = TRANSITIONS.map((t) => `${t.from}->${t.to}`).sort();
    expect(actual).toEqual(LEGAL.map(([f, t]) => `${f}->${t}`).sort());
  });

  it('has no duplicate pairs', () => {
    const pairs = TRANSITIONS.map((t) => `${t.from}->${t.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  // THE brief requirement: "every (from, to) pair not in the table is rejected".
  it('rejects every one of the 64 pairs that is not in the table', () => {
    const legal = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    let checked = 0;

    for (const from of BOOKING_STATUSES) {
      for (const to of BOOKING_STATUSES) {
        checked++;
        const expected = legal.has(`${from}->${to}`);
        expect(isLegalTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }

    expect(checked).toBe(BOOKING_STATUSES.length ** 2);
    expect(BOOKING_STATUSES.length ** 2).toBe(64);
  });

  it('rejects every self-transition', () => {
    for (const status of BOOKING_STATUSES) {
      expect(isLegalTransition(status, status), `${status} -> itself`).toBe(false);
    }
  });

  it('never allows a terminal status to move again', () => {
    // Once a booking leaves the live set it is finished, except CHECKED_OUT,
    // which still owes its bill and may reach PAID.
    for (const status of ['PAID', 'EXPIRED', 'CANCELLED'] as const) {
      expect(legalTargetsFrom(status), status).toEqual([]);
    }
    expect(legalTargetsFrom('CHECKED_OUT')).toEqual(['PAID']);
  });

  it('never re-enters a live status from a terminal one', () => {
    const live = new Set<string>(LIVE_STATUSES);
    for (const t of TRANSITIONS) {
      if (!live.has(t.from)) {
        expect(live.has(t.to), `${t.from} -> ${t.to} resurrects a dead booking`).toBe(false);
      }
    }
  });
});

describe('allowedFromFor', () => {
  it('lists every predecessor, which is what transition() puts in its CAS', () => {
    expect(allowedFromFor('CHECKED_OUT').sort()).toEqual(['CHECKED_IN', 'OVERSTAY']);
    expect(allowedFromFor('EXPIRED').sort()).toEqual(['PENDING_PAYMENT', 'RESERVED']);
    expect(allowedFromFor('RESERVED')).toEqual(['PENDING_PAYMENT']);
    expect(allowedFromFor('PAID')).toEqual(['CHECKED_OUT']);
  });

  it('is empty for a status that can only be created, never transitioned into', () => {
    // PENDING_PAYMENT is only ever a birth state.
    expect(allowedFromFor('PENDING_PAYMENT')).toEqual([]);
  });

  it('agrees with isLegalTransition for every status', () => {
    for (const to of BOOKING_STATUSES) {
      for (const from of allowedFromFor(to)) {
        expect(isLegalTransition(from, to)).toBe(true);
      }
    }
  });
});

describe('creation', () => {
  it('contains exactly the three creation rows in the brief', () => {
    expect(CREATIONS).toHaveLength(3);
    expect(CREATIONS.map((c) => `${c.source}->${c.to}`).sort()).toEqual([
      'app->PENDING_PAYMENT',
      'app->RESERVED',
      'walk_in->CHECKED_IN',
    ]);
  });

  it('allows an app booking to be born only pending payment or reserved', () => {
    expect(creationStatusesFor('app').sort()).toEqual(['PENDING_PAYMENT', 'RESERVED']);
  });

  it('allows a walk-in to be born only checked in', () => {
    expect(creationStatusesFor('walk_in')).toEqual(['CHECKED_IN']);
  });

  it('rejects every other source/status combination', () => {
    const legal = new Set(CREATIONS.map((c) => `${c.source}->${c.to}`));
    for (const source of BOOKING_SOURCES) {
      for (const status of BOOKING_STATUSES) {
        expect(isLegalCreation(source, status), `${source} -> ${status}`).toBe(
          legal.has(`${source}->${status}`),
        );
      }
    }
  });

  it('only ever creates a booking in a live status', () => {
    const live = new Set<string>(LIVE_STATUSES);
    for (const creation of CREATIONS) {
      expect(live.has(creation.to), `${creation.source} -> ${creation.to}`).toBe(true);
    }
  });
});
