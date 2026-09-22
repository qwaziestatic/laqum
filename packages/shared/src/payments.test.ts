import { describe, expect, it } from 'vitest';
import { AmountParseError, providerAmountToSantim, santimToProviderAmount } from './payments.js';

/**
 * The provider speaks decimal birr, this system speaks integer santim, and the
 * equality between them decides whether a payment is accepted. Every boundary
 * here is a place a rounding error could quietly approve the wrong amount.
 */
describe('providerAmountToSantim', () => {
  it('reads whole birr from a string', () => {
    expect(providerAmountToSantim('0')).toBe(0);
    expect(providerAmountToSantim('1')).toBe(100);
    expect(providerAmountToSantim('100')).toBe(10_000);
  });

  it('pads a single decimal place, so "1.5" is 50 santim and not 5', () => {
    expect(providerAmountToSantim('1.5')).toBe(150);
    expect(providerAmountToSantim('1.05')).toBe(105);
    expect(providerAmountToSantim('0.1')).toBe(10);
    expect(providerAmountToSantim('0.01')).toBe(1);
  });

  it('parses the values float arithmetic gets wrong', () => {
    // 100.10 * 100 is 10009.999999999998 in IEEE 754. Parsed digit-wise it is
    // exactly 10010.
    expect(providerAmountToSantim('100.10')).toBe(10_010);
    expect(providerAmountToSantim('1.10')).toBe(110);
    expect(providerAmountToSantim('8.11')).toBe(811);
  });

  it('accepts a JSON number, which is what verify actually returns', () => {
    expect(providerAmountToSantim(100)).toBe(10_000);
    expect(providerAmountToSantim(0)).toBe(0);
    expect(providerAmountToSantim(3.5)).toBe(350);
    expect(providerAmountToSantim(100.1)).toBe(10_010);
  });

  it('tolerates float representation error without inventing precision', () => {
    // 0.1 + 0.2 is 0.30000000000000004; that is still 30 santim.
    expect(providerAmountToSantim(0.1 + 0.2)).toBe(30);
  });

  it('rejects sub-santim precision rather than rounding it into a match', () => {
    expect(() => providerAmountToSantim(0.015)).toThrow(AmountParseError);
    expect(() => providerAmountToSantim('0.015')).toThrow(AmountParseError);
    expect(() => providerAmountToSantim('1.234')).toThrow(AmountParseError);
  });

  it('rejects negatives, non-numbers and infinities', () => {
    for (const value of ['-1', '-0.5', 'abc', '', ' ', '1,000', '1e3']) {
      expect(() => providerAmountToSantim(value), value).toThrow(AmountParseError);
    }
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => providerAmountToSantim(value), String(value)).toThrow(AmountParseError);
    }
  });

  it('trims surrounding whitespace', () => {
    expect(providerAmountToSantim('  25.50  ')).toBe(2550);
  });

  it('rejects an amount too large to be a safe integer of santim', () => {
    expect(() => providerAmountToSantim('999999999999999999')).toThrow(AmountParseError);
  });
});

describe('santimToProviderAmount', () => {
  it('always emits two decimal places', () => {
    expect(santimToProviderAmount(0)).toBe('0.00');
    expect(santimToProviderAmount(1)).toBe('0.01');
    expect(santimToProviderAmount(10)).toBe('0.10');
    expect(santimToProviderAmount(100)).toBe('1.00');
    expect(santimToProviderAmount(2000)).toBe('20.00');
    expect(santimToProviderAmount(10_010)).toBe('100.10');
  });

  it('rejects anything that is not a non-negative integer of santim', () => {
    for (const value of [-1, 1.5, Number.NaN]) {
      expect(() => santimToProviderAmount(value), String(value)).toThrow(AmountParseError);
    }
  });
});

describe('the round trip', () => {
  it('returns the original santim for every value we might charge', () => {
    const values = [0, 1, 9, 10, 99, 100, 101, 150, 999, 1000, 2000, 4500, 10_010, 123_456];
    for (const santim of values) {
      expect(providerAmountToSantim(santimToProviderAmount(santim)), String(santim)).toBe(santim);
    }
  });

  it('survives the string form going through a JSON number', () => {
    // Chapa may echo the amount either way; both must agree.
    for (const santim of [1, 10, 105, 150, 10_010, 811]) {
      const asString = santimToProviderAmount(santim);
      expect(providerAmountToSantim(Number(asString)), asString).toBe(santim);
    }
  });
});
