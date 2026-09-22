import { describe, expect, it } from 'vitest';
import { AppError, ERROR_CODES, ERROR_STATUS, httpStatusFor, isAppError } from './errors.js';

describe('the error code table', () => {
  it('maps every code to a real HTTP status', () => {
    expect(ERROR_CODES.length).toBeGreaterThan(0);
    for (const code of ERROR_CODES) {
      const status = httpStatusFor(code);
      expect(Number.isInteger(status), code).toBe(true);
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
  });

  it('carries the codes the brief names', () => {
    for (const code of [
      'SLOT_TAKEN',
      'LOT_FULL',
      'TOO_FAR',
      'STATE_CONFLICT',
      'OUTSTANDING_BALANCE',
      'SLOT_IN_USE',
      'VALIDATION_ERROR',
    ] as const) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('treats every race and rule conflict as 409', () => {
    expect(ERROR_STATUS.SLOT_TAKEN).toBe(409);
    expect(ERROR_STATUS.LOT_FULL).toBe(409);
    expect(ERROR_STATUS.STATE_CONFLICT).toBe(409);
    expect(ERROR_STATUS.OUTSTANDING_BALANCE).toBe(409);
    expect(ERROR_STATUS.SLOT_IN_USE).toBe(409);
    expect(ERROR_STATUS.ILLEGAL_TRANSITION).toBe(409);
    expect(ERROR_STATUS.ALREADY_HAS_ACTIVE_BOOKING).toBe(409);
  });

  it('keeps the 5xx codes to a known, deliberate set', () => {
    // INTERNAL is the catch-all; PROVIDER_UNAVAILABLE is a 503 because the
    // fault is upstream and the caller should retry. Nothing else may be 5xx,
    // so an unexpected failure cannot leak as one.
    const serverCodes = ERROR_CODES.filter((c) => httpStatusFor(c) >= 500).sort();
    expect(serverCodes).toEqual(['INTERNAL', 'PROVIDER_UNAVAILABLE']);
  });
});

describe('AppError', () => {
  it('derives its status from the code', () => {
    expect(new AppError('SLOT_TAKEN').status).toBe(409);
    expect(new AppError('TOO_FAR').status).toBe(422);
    expect(new AppError('UNAUTHENTICATED').status).toBe(401);
  });

  it('falls back to the code as its message', () => {
    expect(new AppError('LOT_FULL').message).toBe('LOT_FULL');
    expect(new AppError('LOT_FULL', 'no slots left').message).toBe('no slots left');
  });

  it('serialises to the documented wire shape', () => {
    const body = new AppError('VALIDATION_ERROR', 'bad input', { field: 'lotId' }).toBody();
    expect(body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'bad input', details: { field: 'lotId' } },
    });
  });

  it('omits details entirely when there are none', () => {
    const body = new AppError('NOT_FOUND').toBody();
    expect(body.error).not.toHaveProperty('details');
  });

  it('is a real Error, so stack traces and instanceof both work', () => {
    const err = new AppError('INTERNAL');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AppError');
    expect(err.stack).toBeTruthy();
    expect(isAppError(err)).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError('SLOT_TAKEN')).toBe(false);
  });
});
