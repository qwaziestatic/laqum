import { describe, expect, it } from 'vitest';
import { VALIDATION_FALLBACK, forDriver } from '../src/api/messages.js';

/**
 * "Request validation failed" is what the device test showed a driver. The
 * API's wording is for developers; forDriver rewrites it, keeping the code
 * and details for diagnosis.
 */

function validation(...paths: string[]) {
  return {
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    details: { issues: paths.map((path) => ({ path, message: 'Invalid input' })) },
  };
}

describe('forDriver', () => {
  it('replaces the developer wording, and keeps code and details', () => {
    const error = validation('lat', 'lng');

    const shown = forDriver(error);

    expect(shown.message).toBe(VALIDATION_FALLBACK);
    expect(shown.message).not.toMatch(/validation/iu);
    expect(shown.code).toBe('VALIDATION_ERROR');
    expect(shown.details).toBe(error.details);
  });

  it('names the field when it is one the driver typed', () => {
    expect(forDriver(validation('vehiclePlate')).message).toMatch(/plate number/u);
    expect(forDriver(validation('phone')).message).toMatch(/country code/u);
    expect(forDriver(validation('code')).message).toMatch(/6-digit code/u);
  });

  it('prefers a field the driver can fix over one they cannot', () => {
    expect(forDriver(validation('lat', 'vehiclePlate')).message).toMatch(/plate number/u);
  });

  it('falls back when there are no usable details', () => {
    const bare = { code: 'VALIDATION_ERROR', message: 'Request validation failed' };
    expect(forDriver(bare).message).toBe(VALIDATION_FALLBACK);
    expect(forDriver({ ...bare, details: 'nonsense' }).message).toBe(VALIDATION_FALLBACK);
  });

  it('leaves every other error alone', () => {
    const tooFar = { code: 'TOO_FAR', message: 'You are 400 m away' };
    expect(forDriver(tooFar)).toBe(tooFar);
  });
});
