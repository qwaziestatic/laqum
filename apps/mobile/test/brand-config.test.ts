import { BRAND } from '@laqum/shared';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../app.config.js';

/**
 * The icon and the splash are NATIVE: they reach the phone only with the next
 * EAS build (the one that adds Firebase). Until then nothing on a device can
 * catch a wrong path or colour, so this does.
 *
 * Where the mark sits inside Android's safe circle is checked where the
 * images are made: scripts/brand/build.mjs refuses to write a mark that
 * leaves it.
 */

const file = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));

/** Width and height from a PNG's IHDR chunk; no image library needed. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(file(path));
  expect(bytes.subarray(1, 4).toString('latin1'), `${path} is a PNG`).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

interface SplashOptions {
  image: string;
  imageWidth: number;
  backgroundColor: string;
  dark: { image: string; backgroundColor: string };
}

function splashOptions(): SplashOptions {
  const entry = config.plugins?.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen',
  );
  if (!Array.isArray(entry)) throw new Error('expo-splash-screen is not configured');
  return entry[1] as SplashOptions;
}

describe('the app icon', () => {
  it('is the generated 1024 px icon', () => {
    expect(config.icon).toBe('./assets/brand/icon.png');
    expect(pngSize('assets/brand/icon.png')).toEqual({ width: 1024, height: 1024 });
  });

  it('is an adaptive icon with a monochrome layer on a flat background', () => {
    const adaptive = config.android?.adaptiveIcon;
    expect(adaptive).toEqual({
      foregroundImage: './assets/brand/adaptive-foreground.png',
      monochromeImage: './assets/brand/adaptive-monochrome.png',
      backgroundColor: '#ffffff',
    });
    expect(pngSize('assets/brand/adaptive-foreground.png')).toEqual({ width: 1024, height: 1024 });
    expect(pngSize('assets/brand/adaptive-monochrome.png')).toEqual({ width: 1024, height: 1024 });
  });

  it('keeps the iOS configuration valid (untested on a device)', () => {
    expect(config.ios?.bundleIdentifier).toBe('et.laqum.driver');
    // The top-level icon serves iOS too; it must be opaque, which it is.
    expect(existsSync(file('assets/brand/icon.png'))).toBe(true);
  });
});

describe('the native splash', () => {
  it('is the white mark on the brand navy, in both themes', () => {
    const splash = splashOptions();
    expect(splash.backgroundColor).toBe(BRAND.navy);
    expect(splash.dark.backgroundColor).toBe(BRAND.navy);
    expect(splash.image).toBe('./assets/brand/splash-icon.png');
    expect(splash.dark.image).toBe(splash.image);
    // Android 12+ shows the image through a 192 dp circle.
    expect(splash.imageWidth).toBe(192);
    expect(pngSize('assets/brand/splash-icon.png')).toEqual({ width: 1024, height: 1024 });
  });

  it('comes from the same navy the intro continues from', () => {
    const intro = readFileSync(file('src/intro/Intro.tsx'), 'utf8');
    expect(intro).toMatch(/backgroundColor: BRAND\.navy/u);
  });
});

/** Source files under a directory, as paths relative to the app. */
function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(file(dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sources(path, acc);
    else if (/\.(ts|tsx)$/u.test(entry.name)) acc.push(path);
  }
  return acc;
}

describe('brand colours are identity, not interface (docs/BRAND.md)', () => {
  it('appear only in the intro, never on the operational screens', () => {
    const offenders = [...sources('app'), ...sources('src')].filter((path) => {
      if (path.startsWith('src/intro/')) return false;
      const text = readFileSync(file(path), 'utf8');
      const usesHex = [BRAND.navy, BRAND.orange].some((hex) => text.toLowerCase().includes(hex));
      return usesHex || /\bBRAND\b/u.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
