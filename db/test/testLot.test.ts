import { describe, expect, it } from 'vitest';
import { TEST_LOT_NAME, testLotFromEnv } from '../seed/seed.js';

/**
 * The test lot exists so device testing can happen where the tester actually
 * is. That makes it a seeding path driven by ENVIRONMENT, which is exactly the
 * kind of thing that escapes into production, so the refusals are what get
 * tested hardest.
 */

describe('it is impossible to run in production', () => {
  it('REFUSES when NODE_ENV is production', () => {
    expect(() =>
      testLotFromEnv({
        NODE_ENV: 'production',
        SEED_TEST_LOT_LAT: '9.03',
        SEED_TEST_LOT_LNG: '38.75',
      }),
    ).toThrow(/production/u);
  });

  it('refuses in production even with only ONE coordinate set', () => {
    // The production check comes BEFORE the both-or-neither check, so a
    // half-configured production environment still fails on the right reason.
    expect(() => testLotFromEnv({ NODE_ENV: 'production', SEED_TEST_LOT_LAT: '9.03' })).toThrow(
      /production/u,
    );
  });
});

describe('opting in', () => {
  it('is absent unless asked for', () => {
    // The overwhelmingly common case: a normal seed must be unchanged.
    expect(testLotFromEnv({})).toBeNull();
    expect(testLotFromEnv({ NODE_ENV: 'development' })).toBeNull();
  });

  it('builds a lot from a coordinate pair', () => {
    const lot = testLotFromEnv({ SEED_TEST_LOT_LAT: '9.0348', SEED_TEST_LOT_LNG: '38.7508' });
    expect(lot).toEqual({ latitude: 9.0348, longitude: 38.7508, radiusM: 150 });
  });

  it('accepts a custom radius', () => {
    const lot = testLotFromEnv({
      SEED_TEST_LOT_LAT: '51.5',
      SEED_TEST_LOT_LNG: '-0.12',
      SEED_TEST_LOT_RADIUS_M: '80',
    });
    expect(lot?.radiusM).toBe(80);
  });

  it('handles a negative longitude', () => {
    // Half the world. Worth one assertion, because a naive parse or a stray
    // Math.abs would put the tester on the wrong continent.
    expect(testLotFromEnv({ SEED_TEST_LOT_LAT: '40.7', SEED_TEST_LOT_LNG: '-74.0' })).toMatchObject(
      { longitude: -74 },
    );
  });
});

describe('a bad coordinate fails loudly, not silently', () => {
  it('refuses ONE coordinate without the other', () => {
    // Silently ignoring a half-set pair would leave the tester wondering why
    // no test lot appeared.
    expect(() => testLotFromEnv({ SEED_TEST_LOT_LAT: '9.03' })).toThrow(/BOTH/u);
    expect(() => testLotFromEnv({ SEED_TEST_LOT_LNG: '38.75' })).toThrow(/BOTH/u);
  });

  it('refuses a latitude outside -90..90', () => {
    /*
     * The realistic mistake is swapping the pair: an Addis longitude of 38.75
     * is a valid latitude, but a latitude of 9.03 in the longitude slot is
     * silently plausible too. The range check catches the out-of-range half
     * and the tester notices the lot is in the wrong place either way — but
     * an unparseable value must never become NaN in the database.
     */
    for (const bad of ['91', '-91', 'abc', '']) {
      expect(() => testLotFromEnv({ SEED_TEST_LOT_LAT: bad, SEED_TEST_LOT_LNG: '38.75' })).toThrow(
        /SEED_TEST_LOT_LAT/u,
      );
    }
  });

  it('refuses a longitude outside -180..180', () => {
    for (const bad of ['181', '-181', 'xyz']) {
      expect(() => testLotFromEnv({ SEED_TEST_LOT_LAT: '9.03', SEED_TEST_LOT_LNG: bad })).toThrow(
        /SEED_TEST_LOT_LNG/u,
      );
    }
  });

  it('refuses a non-positive radius', () => {
    for (const bad of ['0', '-10', 'wide']) {
      expect(() =>
        testLotFromEnv({
          SEED_TEST_LOT_LAT: '9.03',
          SEED_TEST_LOT_LNG: '38.75',
          SEED_TEST_LOT_RADIUS_M: bad,
        }),
      ).toThrow(/RADIUS/u);
    }
  });
});

describe('the name is obvious', () => {
  it('says it is a test lot, so it is never mistaken for a real one', () => {
    expect(TEST_LOT_NAME).toMatch(/TEST/u);
  });
});
