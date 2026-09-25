import { describe, expect, it } from 'vitest';
import {
  AMHARIC_DAY_PERIODS,
  DISPLAY_UTC_OFFSET_MINUTES,
  addisClock,
  ethiopianHour,
  formatClock,
} from './clockDisplay.js';
import { DISPLAY_TIMEZONE } from './constants.js';

/** An instant that reads `hh:mm` in Addis Ababa (UTC+3). */
function addis(hhmm: string, seconds = 0): Date {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 8, 25, hh - 3, mm, seconds));
}

describe('the Ethiopian clock on Amharic screens', () => {
  it('reads the example the product owner gave', () => {
    expect(formatClock(addis('14:05'), 'am')).toBe('ከሰዓት 8:05');
  });

  it('is right at every boundary of every time-of-day word', () => {
    const cases: [string, string][] = [
      ['00:00', 'ሌሊት 6:00'],
      ['05:59', 'ሌሊት 11:59'],
      ['06:00', 'ጠዋት 12:00'],
      ['11:59', 'ጠዋት 5:59'],
      ['12:00', 'ከሰዓት 6:00'],
      ['17:59', 'ከሰዓት 11:59'],
      ['18:00', 'ምሽት 12:00'],
      ['23:59', 'ምሽት 5:59'],
    ];
    for (const [international, amharic] of cases) {
      expect(formatClock(addis(international), 'am'), international).toBe(amharic);
    }
  });

  it('counts the hour as (hour + 6) mod 12, with 0 shown as 12, for every hour', () => {
    const expected = [6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5];
    expect(Array.from({ length: 24 }, (_, hour) => ethiopianHour(hour))).toEqual(expected);
  });

  it('gives every hour exactly one time-of-day word', () => {
    for (let hour = 0; hour < 24; hour++) {
      const covering = AMHARIC_DAY_PERIODS.filter((p) => hour >= p.from && hour < p.to);
      expect(covering, String(hour)).toHaveLength(1);
    }
  });

  it('keeps the seconds when asked, and pads minutes but not the hour', () => {
    expect(formatClock(addis('07:03', 9), 'am', { seconds: true })).toBe('ጠዋት 1:03:09');
  });
});

describe('international time on English screens', () => {
  it('is 24-hour and zero-padded', () => {
    expect(formatClock(addis('14:05'), 'en')).toBe('14:05');
    expect(formatClock(addis('07:03', 9), 'en', { seconds: true })).toBe('07:03:09');
    expect(formatClock(addis('00:00'), 'en')).toBe('00:00');
  });
});

describe('Addis Ababa time, whatever zone the device is in', () => {
  it('turns a UTC instant into Addis time, across midnight', () => {
    expect(addisClock(new Date('2026-09-25T22:30:00Z'))).toEqual({
      hour: 1,
      minute: 30,
      second: 0,
    });
    expect(addisClock(new Date('2026-09-25T20:59:59Z'))).toEqual({
      hour: 23,
      minute: 59,
      second: 59,
    });
  });

  it('uses the offset the time-zone database gives Africa/Addis_Ababa, all year', () => {
    const format = new Intl.DateTimeFormat('en-GB', {
      timeZone: DISPLAY_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    for (const month of [0, 3, 6, 9]) {
      const instant = new Date(Date.UTC(2026, month, 15, 10, 20));
      const { hour, minute } = addisClock(instant);
      expect(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`).toBe(
        format.format(instant),
      );
    }
    expect(DISPLAY_UTC_OFFSET_MINUTES).toBe(180);
  });
});
