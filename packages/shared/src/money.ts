import { z } from 'zod';
import { SANTIM_PER_BIRR } from './constants.js';

/**
 * Money is an integer count of santim (1 ETB = 100 santim). Never a float,
 * never a numeric string. These helpers exist so no caller is ever tempted to
 * reach for `parseFloat` or `toFixed` on a money value.
 */

export const santimSchema = z.int().nonnegative();

/** A signed amount, for deltas and credits. */
export const santimDeltaSchema = z.int();

/**
 * Format santim for display, e.g. 12345 -> "123.45".
 * Integer arithmetic only: no float ever touches the value.
 */
export function formatSantim(santim: number): string {
  if (!Number.isSafeInteger(santim)) {
    throw new RangeError(`santim must be a safe integer, received ${santim}`);
  }
  const negative = santim < 0;
  const abs = Math.abs(santim);
  const birr = Math.trunc(abs / SANTIM_PER_BIRR);
  const remainder = abs % SANTIM_PER_BIRR;
  return `${negative ? '-' : ''}${birr}.${remainder.toString().padStart(2, '0')}`;
}

/** Format for a UI label, e.g. 12345 -> "123.45 ETB". */
export function formatBirr(santim: number): string {
  return `${formatSantim(santim)} ETB`;
}

/**
 * Convert whole birr to santim. Takes an integer count of birr on purpose:
 * accepting 12.34 would invite float rounding into the money path.
 */
export function birrToSantim(wholeBirr: number): number {
  if (!Number.isSafeInteger(wholeBirr)) {
    throw new RangeError(`whole birr must be a safe integer, received ${wholeBirr}`);
  }
  return wholeBirr * SANTIM_PER_BIRR;
}

/**
 * Charge in whole blocks, rounding any part-block up. Used by the billing
 * function in Phase 1 for both planned and overstay time.
 */
export function blocksFor(minutes: number, blockMinutes: number): number {
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new RangeError(`minutes must be a non-negative safe integer, received ${minutes}`);
  }
  if (!Number.isSafeInteger(blockMinutes) || blockMinutes <= 0) {
    throw new RangeError(`blockMinutes must be a positive safe integer, received ${blockMinutes}`);
  }
  return Math.ceil(minutes / blockMinutes);
}
