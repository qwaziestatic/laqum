import type { Locale } from './constants.js';

/**
 * CLOCK TIMES AS PEOPLE READ THEM (the product owner's decision).
 *
 * English screens: international 24-hour time, 14:05.
 * Amharic screens: the Ethiopian 12-hour clock with a time-of-day word,
 * ከሰዓት 8:05. The Ethiopian day starts at dawn: international 06:00 is 12
 * o'clock, 07:00 is 1 o'clock. Hour = (international hour + 6) mod 12, with 0
 * shown as 12.
 *
 * Clock times only. Durations and countdowns (02:45) are the same in both
 * languages and never go through here. Nothing in either app shows a date.
 *
 * Always in Addis Ababa time, whatever zone the phone or the browser is set
 * to: the lot is in Addis, and so is the driver's booking.
 */

/** Addis Ababa is UTC+3 all year, with no daylight saving. clockDisplay.test.ts checks this against the time-zone database. */
export const DISPLAY_UTC_OFFSET_MINUTES = 180;

/**
 * The Amharic time-of-day words, and the international hours each covers
 * (from inclusive, to exclusive). Proposed; for the product owner's
 * confirmation in docs/AMHARIC-REVIEW.md.
 */
export const AMHARIC_DAY_PERIODS = [
  /** Night: Ethiopian 6:00 to 11:59. */
  { from: 0, to: 6, word: 'ሌሊት' },
  /** Morning: Ethiopian 12:00 to 5:59. */
  { from: 6, to: 12, word: 'ጠዋት' },
  /** Afternoon: Ethiopian 6:00 (noon) to 11:59. */
  { from: 12, to: 18, word: 'ከሰዓት' },
  /** Evening: Ethiopian 12:00 to 5:59. */
  { from: 18, to: 24, word: 'ምሽት' },
] as const;

export interface ClockParts {
  /** International, 0 to 23. */
  hour: number;
  minute: number;
  second: number;
}

/** The time in Addis Ababa, from any instant. */
export function addisClock(instant: Date): ClockParts {
  const minutesOfDay =
    (((instant.getUTCHours() * 60 + instant.getUTCMinutes() + DISPLAY_UTC_OFFSET_MINUTES) % 1440) +
      1440) %
    1440;
  return {
    hour: Math.floor(minutesOfDay / 60),
    minute: minutesOfDay % 60,
    second: instant.getUTCSeconds(),
  };
}

/** International hour (0 to 23) to the Ethiopian clock's (1 to 12). */
export function ethiopianHour(hour: number): number {
  const shifted = (hour + 6) % 12;
  return shifted === 0 ? 12 : shifted;
}

export function amharicDayPeriod(hour: number): string {
  const period = AMHARIC_DAY_PERIODS.find((p) => hour >= p.from && hour < p.to);
  if (!period) throw new RangeError(`not an hour of the day: ${String(hour)}`);
  return period.word;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** A clock time for a screen in `locale`: "14:05" or "ከሰዓት 8:05". */
export function formatClock(
  instant: Date,
  locale: Locale,
  options: { seconds?: boolean } = {},
): string {
  const { hour, minute, second } = addisClock(instant);
  const tail = options.seconds ? `:${pad(minute)}:${pad(second)}` : `:${pad(minute)}`;
  if (locale === 'en') return `${pad(hour)}${tail}`;
  return `${amharicDayPeriod(hour)} ${String(ethiopianHour(hour))}${tail}`;
}
