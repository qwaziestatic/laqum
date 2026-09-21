import { describe, expect, it } from 'vitest';
import {
  createLotSchema,
  looksLikeShortCode,
  otpVerifySchema,
  phoneSchema,
  updateLotSchema,
} from './schemas.js';

describe('phoneSchema', () => {
  it('accepts E.164 numbers', () => {
    for (const phone of ['+251911234567', '+12025550123', '+4407911123456']) {
      expect(phoneSchema.parse(phone)).toBe(phone);
    }
  });

  it('rejects anything else', () => {
    for (const phone of ['0911234567', '251911234567', '+0911234567', '+251', '']) {
      expect(phoneSchema.safeParse(phone).success, phone).toBe(false);
    }
  });

  it('trims surrounding whitespace', () => {
    expect(phoneSchema.parse('  +251911234567  ')).toBe('+251911234567');
  });
});

describe('otpVerifySchema', () => {
  it('requires exactly six digits', () => {
    expect(otpVerifySchema.safeParse({ phone: '+251911234567', code: '123456' }).success).toBe(
      true,
    );
    for (const code of ['12345', '1234567', 'abcdef', '12 34 56']) {
      expect(otpVerifySchema.safeParse({ phone: '+251911234567', code }).success, code).toBe(false);
    }
  });
});

describe('looksLikeShortCode', () => {
  it('recognises a short code in either case', () => {
    expect(looksLikeShortCode('ABCDEF')).toBe(true);
    expect(looksLikeShortCode('abcdef')).toBe(true);
    expect(looksLikeShortCode('  A2B3C4  ')).toBe(true);
  });

  it('rejects the excluded characters and wrong lengths', () => {
    // The alphabet omits 0/O and 1/I so an attendant can read codes aloud.
    expect(looksLikeShortCode('ABCDE0')).toBe(false);
    expect(looksLikeShortCode('ABCDEI')).toBe(false);
    expect(looksLikeShortCode('ABCDE')).toBe(false);
    expect(looksLikeShortCode('ABCDEFG')).toBe(false);
  });

  it('rejects a QR token, which is how the two are told apart', () => {
    expect(looksLikeShortCode('Zm9vYmFyYmF6cXV4')).toBe(false);
  });
});

describe('updateLotSchema', () => {
  it('rejects an empty patch', () => {
    expect(updateLotSchema.safeParse({}).success).toBe(false);
  });

  it('does NOT reinstate defaults for absent fields', () => {
    // The trap this schema exists to avoid: createLotSchema.partial() keeps
    // its .default()s, so an empty PATCH would silently reset the lot's
    // windows and deposit.
    const parsed = updateLotSchema.parse({ name: 'Renamed' });

    expect(parsed).toEqual({ name: 'Renamed' });
    for (const key of [
      'blockMinutes',
      'holdMinutes',
      'paymentWindowMinutes',
      'depositAmountSantim',
      'maxBookingDistanceM',
    ]) {
      expect(Object.keys(parsed), key).not.toContain(key);
    }
  });

  it('still applies those defaults on CREATE, where they belong', () => {
    const created = createLotSchema.parse({
      operatorId: '11111111-1111-4111-8111-111111111111',
      name: 'New Lot',
      latitude: 9,
      longitude: 38.7,
      contactPhone: '+251911234567',
      ratePerBlockSantim: 2000,
      overstayRatePerBlockSantim: 4000,
    });

    expect(created.blockMinutes).toBe(30);
    expect(created.holdMinutes).toBe(15);
    expect(created.paymentWindowMinutes).toBe(3);
    expect(created.depositAmountSantim).toBe(0);
    expect(created.maxBookingDistanceM).toBe(10_000);
  });
});
