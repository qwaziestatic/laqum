import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiUrlFor } from '../app.config.js';

/**
 * The production build: an APK distributed directly (Google Play needs a
 * card), and never one that cannot reach its server.
 */

describe('the API address a build is given', () => {
  it('falls back to localhost outside production, for development', () => {
    expect(apiUrlFor({})).toBe('http://localhost:3000/v1');
    expect(apiUrlFor({ EAS_BUILD_PROFILE: 'development' })).toBe('http://localhost:3000/v1');
    expect(
      apiUrlFor({
        EAS_BUILD_PROFILE: 'development',
        EXPO_PUBLIC_API_URL: 'http://10.0.0.5:3000/v1',
      }),
    ).toBe('http://10.0.0.5:3000/v1');
  });

  it('REFUSES a production build without one', () => {
    for (const missing of [undefined, '', '   ']) {
      expect(
        () => apiUrlFor({ EAS_BUILD_PROFILE: 'production', EXPO_PUBLIC_API_URL: missing }),
        String(missing),
      ).toThrow(/Refusing a production build without EXPO_PUBLIC_API_URL/u);
    }
  });

  it('REFUSES a production build with a cleartext address, which production blocks', () => {
    expect(() =>
      apiUrlFor({ EAS_BUILD_PROFILE: 'production', EXPO_PUBLIC_API_URL: 'http://laqum.com.et/v1' }),
    ).toThrow(/must start with https:\/\//u);
  });

  it('takes an https address in production', () => {
    expect(
      apiUrlFor({
        EAS_BUILD_PROFILE: 'production',
        EXPO_PUBLIC_API_URL: 'https://laqum.com.et/v1',
      }),
    ).toBe('https://laqum.com.et/v1');
  });
});

describe('the production EAS profile', () => {
  const eas = JSON.parse(
    readFileSync(fileURLToPath(new URL('../eas.json', import.meta.url)), 'utf8'),
  ) as { build: Record<string, Record<string, unknown>> };
  const production = eas.build.production;

  it('builds an APK for direct distribution, not a Play Store bundle', () => {
    expect(production).toMatchObject({ distribution: 'internal', android: { buildType: 'apk' } });
  });

  it("reads the PRODUCTION environment's variables, which internal builds do not by default", () => {
    // Without it, EAS picks "preview" for a non-store profile, and the build
    // would not see the production EXPO_PUBLIC_API_URL.
    expect(production?.environment).toBe('production');
  });
});
