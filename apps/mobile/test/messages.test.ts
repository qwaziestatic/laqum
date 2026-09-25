import { ERROR_CODES } from '@laqum/shared';
import { describe, expect, it } from 'vitest';
import { errorPhrase } from '../src/api/messages.js';
import { translator } from '../src/i18n/core.js';

/**
 * What a driver reads when a request fails. The API's message is developer
 * English ("Request validation failed" reached the Book screen on the device
 * test) and is never shown: the CODE decides the text, in the driver's
 * language.
 */

const english = translator('en');
const amharic = translator('am');

function validation(...paths: string[]) {
  return {
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    details: { issues: paths.map((path) => ({ path, message: 'Invalid input' })) },
  };
}

describe('errorPhrase', () => {
  it('never shows the API wording for a field the app built', () => {
    const shown = english(errorPhrase(validation('lat', 'lng')));
    expect(shown).toMatch(/update the app/u);
    expect(shown).not.toMatch(/validation/iu);
  });

  it('names the field the driver typed', () => {
    expect(english(errorPhrase(validation('vehiclePlate')))).toMatch(/plate number/u);
    expect(english(errorPhrase(validation('phone')))).toMatch(/country code/u);
    expect(english(errorPhrase(validation('code')))).toMatch(/6-digit code/u);
  });

  it('prefers a field the driver can fix when several are rejected', () => {
    expect(english(errorPhrase(validation('lat', 'vehiclePlate')))).toMatch(/plate number/u);
  });

  it('falls back when the details are missing or malformed', () => {
    const bare = { code: 'VALIDATION_ERROR', message: 'Request validation failed' };
    expect(errorPhrase(bare)).toEqual({ key: 'errors.VALIDATION_ERROR' });
    expect(errorPhrase({ ...bare, details: 'nonsense' })).toEqual({
      key: 'errors.VALIDATION_ERROR',
    });
  });

  it('has driver text for EVERY API error code, in both languages, never the API message', () => {
    for (const code of ERROR_CODES) {
      const error = { code, message: `developer message for ${code}` };
      for (const translate of [english, amharic]) {
        const shown = translate(errorPhrase(error));
        expect(shown, code).not.toContain('developer message');
        expect(shown, code).not.toBe(errorPhrase(error).key);
      }
    }
  });

  it('words the failures that never reached the server', () => {
    expect(errorPhrase({ code: 'NETWORK', message: 'fetch failed' })).toEqual({
      key: 'errors.NETWORK',
    });
    expect(errorPhrase({ code: 'BAD_RESPONSE', message: 'HTTP 502' })).toEqual({
      key: 'errors.BAD_RESPONSE',
    });
    // Anything unrecognised is a generic apology, not whatever came back.
    expect(errorPhrase({ code: 'SOMETHING_NEW', message: 'Kaboom' })).toEqual({
      key: 'errors.UNKNOWN',
    });
  });
});
