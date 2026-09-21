import { describe, expect, it } from 'vitest';
import { birrToSantim, blocksFor, formatBirr, formatSantim } from './money.js';

describe('formatSantim', () => {
  it('pads the santim remainder to two digits', () => {
    expect(formatSantim(0)).toBe('0.00');
    expect(formatSantim(5)).toBe('0.05');
    expect(formatSantim(50)).toBe('0.50');
    expect(formatSantim(100)).toBe('1.00');
    expect(formatSantim(12345)).toBe('123.45');
  });

  it('handles negative amounts without losing the leading zero', () => {
    expect(formatSantim(-5)).toBe('-0.05');
    expect(formatSantim(-12345)).toBe('-123.45');
  });

  it('rejects non-integers rather than silently truncating', () => {
    expect(() => formatSantim(12.5)).toThrow(RangeError);
    expect(() => formatSantim(Number.NaN)).toThrow(RangeError);
    expect(() => formatSantim(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe('formatBirr', () => {
  it('appends the currency label', () => {
    expect(formatBirr(2500)).toBe('25.00 ETB');
  });
});

describe('birrToSantim', () => {
  it('scales whole birr', () => {
    expect(birrToSantim(0)).toBe(0);
    expect(birrToSantim(25)).toBe(2500);
  });

  it('refuses fractional birr, which would invite float rounding', () => {
    expect(() => birrToSantim(25.5)).toThrow(RangeError);
  });
});

describe('blocksFor', () => {
  it('charges whole blocks, rounding a part block up', () => {
    expect(blocksFor(0, 30)).toBe(0);
    expect(blocksFor(1, 30)).toBe(1);
    expect(blocksFor(30, 30)).toBe(1);
    expect(blocksFor(31, 30)).toBe(2);
    expect(blocksFor(60, 30)).toBe(2);
  });

  it('rejects a non-positive block size', () => {
    expect(() => blocksFor(30, 0)).toThrow(RangeError);
    expect(() => blocksFor(30, -30)).toThrow(RangeError);
  });

  it('rejects negative minutes', () => {
    expect(() => blocksFor(-1, 30)).toThrow(RangeError);
  });
});
