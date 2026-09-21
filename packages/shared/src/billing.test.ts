import { describe, expect, it } from 'vitest';
import { computeBill, type BillableBooking, type BillableLot } from './billing.js';

/** Bole's seeded economics: 30-minute blocks, 20 ETB, 40 ETB overstay. */
const LOT: BillableLot = {
  block_minutes: 30,
  rate_per_block_santim: 2000,
  overstay_rate_per_block_santim: 4000,
};

const CHECKED_IN_AT = new Date('2026-03-01T08:00:00.000Z');
/** 60 planned minutes => planned end at 09:00. */
const PLANNED_END = new Date('2026-03-01T09:00:00.000Z');

function appBooking(overrides: Partial<BillableBooking> = {}): BillableBooking {
  return {
    source: 'app',
    planned_minutes: 60,
    checked_in_at: CHECKED_IN_AT,
    planned_end_at: PLANNED_END,
    deposit_paid_santim: 0,
    ...overrides,
  };
}

function walkIn(overrides: Partial<BillableBooking> = {}): BillableBooking {
  return {
    source: 'walk_in',
    planned_minutes: null,
    checked_in_at: CHECKED_IN_AT,
    planned_end_at: null,
    deposit_paid_santim: 0,
    ...overrides,
  };
}

function at(iso: string): Date {
  return new Date(iso);
}

describe('app bookings', () => {
  it('charges the planned blocks when the driver leaves exactly on time', () => {
    const bill = computeBill(appBooking(), LOT, PLANNED_END);

    expect(bill.subtotalSantim).toBe(4000); // 2 blocks x 20 ETB
    expect(bill.amountDueSantim).toBe(4000);
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]).toMatchObject({ kind: 'planned', blocks: 2, minutes: 60 });
  });

  it('charges no overstay one millisecond before the deadline', () => {
    const bill = computeBill(appBooking(), LOT, at('2026-03-01T08:59:59.999Z'));
    expect(bill.lines.map((l) => l.kind)).toEqual(['planned']);
    expect(bill.amountDueSantim).toBe(4000);
  });

  it('charges a full overstay block one minute over', () => {
    const bill = computeBill(appBooking(), LOT, at('2026-03-01T09:01:00.000Z'));

    expect(bill.lines.map((l) => l.kind)).toEqual(['planned', 'overstay']);
    expect(bill.lines[1]).toMatchObject({ kind: 'overstay', minutes: 1, blocks: 1 });
    expect(bill.subtotalSantim).toBe(4000 + 4000);
    expect(bill.amountDueSantim).toBe(8000);
  });

  it('charges a full overstay block one SECOND over', () => {
    // Pins the stated rounding rule: any part-minute is a minute, any
    // part-block is a block. A second late costs a block.
    const bill = computeBill(appBooking(), LOT, at('2026-03-01T09:00:01.000Z'));
    expect(bill.lines[1]).toMatchObject({ kind: 'overstay', minutes: 1, blocks: 1 });
    expect(bill.amountDueSantim).toBe(8000);
  });

  it('charges exactly one overstay block at the block boundary', () => {
    const bill = computeBill(appBooking(), LOT, at('2026-03-01T09:30:00.000Z'));
    expect(bill.lines[1]).toMatchObject({ minutes: 30, blocks: 1 });
    expect(bill.amountDueSantim).toBe(8000);
  });

  it('charges two overstay blocks one minute past the block boundary', () => {
    const bill = computeBill(appBooking(), LOT, at('2026-03-01T09:31:00.000Z'));
    expect(bill.lines[1]).toMatchObject({ minutes: 31, blocks: 2 });
    expect(bill.amountDueSantim).toBe(4000 + 8000);
  });

  it('gives no refund for leaving early', () => {
    // Left after 5 of 60 planned minutes; still owes both planned blocks.
    const bill = computeBill(appBooking(), LOT, at('2026-03-01T08:05:00.000Z'));
    expect(bill.lines.map((l) => l.kind)).toEqual(['planned']);
    expect(bill.amountDueSantim).toBe(4000);
  });

  it('credits the deposit against the bill', () => {
    const bill = computeBill(appBooking({ deposit_paid_santim: 2000 }), LOT, PLANNED_END);

    expect(bill.subtotalSantim).toBe(4000);
    expect(bill.depositCreditSantim).toBe(2000);
    expect(bill.depositUnusedSantim).toBe(0);
    expect(bill.amountDueSantim).toBe(2000);
    expect(bill.lines.at(-1)).toMatchObject({ kind: 'deposit_credit', amountSantim: -2000 });
  });

  it('floors at zero when the deposit is larger than the bill, and refunds nothing', () => {
    const bill = computeBill(
      appBooking({ planned_minutes: 30, deposit_paid_santim: 5000 }),
      LOT,
      at('2026-03-01T08:30:00.000Z'),
    );

    expect(bill.subtotalSantim).toBe(2000);
    expect(bill.depositCreditSantim).toBe(2000); // only what the bill absorbs
    expect(bill.depositUnusedSantim).toBe(3000); // kept, never auto-refunded
    expect(bill.amountDueSantim).toBe(0);
  });

  it('bills nothing extra before check-in, when planned_end_at is still null', () => {
    const bill = computeBill(
      appBooking({ checked_in_at: null, planned_end_at: null }),
      LOT,
      at('2026-03-01T23:00:00.000Z'),
    );
    expect(bill.lines.map((l) => l.kind)).toEqual(['planned']);
    expect(bill.amountDueSantim).toBe(4000);
  });

  it('handles a free lot without producing a negative bill', () => {
    const freeLot: BillableLot = {
      block_minutes: 30,
      rate_per_block_santim: 0,
      overstay_rate_per_block_santim: 0,
    };
    const bill = computeBill(appBooking(), freeLot, at('2026-03-01T12:00:00.000Z'));
    expect(bill.amountDueSantim).toBe(0);
  });
});

describe('walk-ins', () => {
  it('charges a minimum of one block for a zero-length stay', () => {
    const bill = computeBill(walkIn(), LOT, CHECKED_IN_AT);

    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]).toMatchObject({ kind: 'walk_in', minutes: 0, blocks: 1 });
    expect(bill.amountDueSantim).toBe(2000);
  });

  it('charges one block exactly on the block boundary', () => {
    const bill = computeBill(walkIn(), LOT, at('2026-03-01T08:30:00.000Z'));
    expect(bill.lines[0]).toMatchObject({ minutes: 30, blocks: 1 });
    expect(bill.amountDueSantim).toBe(2000);
  });

  it('charges two blocks one minute past the boundary', () => {
    const bill = computeBill(walkIn(), LOT, at('2026-03-01T08:31:00.000Z'));
    expect(bill.lines[0]).toMatchObject({ minutes: 31, blocks: 2 });
    expect(bill.amountDueSantim).toBe(4000);
  });

  it('never charges the overstay rate, however long the car stays', () => {
    // Walk-ins have no planned end and never enter OVERSTAY.
    const bill = computeBill(walkIn(), LOT, at('2026-03-01T20:00:00.000Z'));
    expect(bill.lines.map((l) => l.kind)).toEqual(['walk_in']);
    expect(bill.lines[0]?.unitSantim).toBe(LOT.rate_per_block_santim);
    expect(bill.lines[0]).toMatchObject({ minutes: 720, blocks: 24 });
    expect(bill.amountDueSantim).toBe(48_000);
  });

  it('treats a clock that went backwards as a zero-length stay', () => {
    const bill = computeBill(walkIn(), LOT, at('2026-03-01T07:00:00.000Z'));
    expect(bill.lines[0]).toMatchObject({ minutes: 0, blocks: 1 });
    expect(bill.amountDueSantim).toBe(2000);
  });
});

describe('the breakdown itself', () => {
  it('has lines that sum to the amount due', () => {
    const cases: [BillableBooking, Date][] = [
      [appBooking(), PLANNED_END],
      [appBooking({ deposit_paid_santim: 2000 }), at('2026-03-01T09:45:00.000Z')],
      [appBooking({ deposit_paid_santim: 999_999 }), at('2026-03-01T09:45:00.000Z')],
      [walkIn(), at('2026-03-01T09:13:00.000Z')],
    ];

    for (const [booking, checkoutAt] of cases) {
      const bill = computeBill(booking, LOT, checkoutAt);
      const summed = bill.lines.reduce((total, line) => total + line.amountSantim, 0);
      expect(summed).toBe(bill.amountDueSantim);
    }
  });

  it('is always a non-negative integer number of santim', () => {
    const deposits = [0, 1, 1999, 2000, 2001, 1_000_000];
    const checkouts = [
      '2026-03-01T07:00:00.000Z',
      '2026-03-01T09:00:00.000Z',
      '2026-03-01T09:00:00.001Z',
      '2026-03-01T11:17:00.000Z',
    ];

    for (const deposit of deposits) {
      for (const iso of checkouts) {
        const bill = computeBill(appBooking({ deposit_paid_santim: deposit }), LOT, at(iso));
        expect(Number.isInteger(bill.amountDueSantim)).toBe(true);
        expect(bill.amountDueSantim).toBeGreaterThanOrEqual(0);
        expect(bill.depositCreditSantim + bill.depositUnusedSantim).toBe(deposit);
      }
    }
  });

  it('omits the deposit line entirely when no deposit was paid', () => {
    const bill = computeBill(appBooking(), LOT, PLANNED_END);
    expect(bill.lines.some((l) => l.kind === 'deposit_credit')).toBe(false);
  });
});
