import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  INTRO_EXIT,
  INTRO_MAX_MS,
  INTRO_SETTLED_MS,
  INTRO_TRACKS,
  REDUCED_MOTION_MS,
  claimColdStart,
  introPlan,
  introStage,
  openedByLink,
  resetColdStartForTests,
  trackValueAt,
} from '../src/intro/timeline.js';

/**
 * THE OPENING ANIMATION'S RULES, which are the product owner's:
 * cold start only; never when opened by a link; at most 1.2 s of opacity
 * and transform on the native driver; never slower than max(animation,
 * readiness); a static frame for reduced motion. The drawing itself is
 * checked on the phone (DEVICE-TEST.md, step 22).
 */

const file = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const INTRO_SOURCE = readFileSync(file('src/intro/Intro.tsx'), 'utf8');
const SCHEME = 'laqum';

const plan = (overrides: Partial<Parameters<typeof introPlan>[0]> = {}) =>
  introPlan({
    coldStart: true,
    initialUrl: null,
    appScheme: SCHEME,
    reduceMotion: false,
    ...overrides,
  });

describe('it plays on a cold start only', () => {
  beforeEach(() => {
    resetColdStartForTests();
  });

  it('claims the cold start once per JavaScript runtime', () => {
    expect(claimColdStart()).toBe(true);
    // A second mount in the same runtime (reopened after Back) is warm.
    expect(claimColdStart()).toBe(false);
    expect(claimColdStart()).toBe(false);
  });

  it('skips when it is not a cold start', () => {
    expect(plan({ coldStart: false })).toEqual({ kind: 'skip', reason: 'not-cold-start' });
  });

  it('never plays on a return to the foreground: nothing re-mounts the root there', () => {
    // The overlay is mounted once, in the root layout, and the foreground
    // handler (state/app.tsx) only bumps an epoch. Pin both facts.
    const layout = readFileSync(file('app/_layout.tsx'), 'utf8');
    expect(layout.match(/<Intro\b/gu)).toHaveLength(1);
    const app = readFileSync(file('src/state/app.tsx'), 'utf8');
    expect(app).not.toMatch(/claimColdStart|Intro/u);
  });

  it('claims the cold start synchronously, so a warm start draws no frame at all', () => {
    expect(INTRO_SOURCE).toMatch(/useState\(claimColdStart\)/u);
  });
});

describe('it is skipped when the app was opened by a link', () => {
  it('skips for a link in the app’s own scheme', () => {
    expect(plan({ initialUrl: 'laqum://booking/0b7a' })).toEqual({
      kind: 'skip',
      reason: 'opened-by-link',
    });
    expect(openedByLink('LAQUM://checkout/1', SCHEME)).toBe(true);
  });

  it('plays for a tap on the icon (no URL) and for the development launcher', () => {
    expect(plan({ initialUrl: null }).kind).toBe('animate');
    expect(
      plan({
        initialUrl: 'exp+laqum://expo-development-client/?url=http%3A%2F%2F192.168.1.5%3A18081',
      }).kind,
    ).toBe('animate');
  });

  it('does not mistake another scheme that merely contains the name', () => {
    expect(openedByLink('laqumx://a', SCHEME)).toBe(false);
    expect(openedByLink('https://laqum.example/booking', SCHEME)).toBe(false);
  });
});

describe('reduced motion', () => {
  it('holds one static frame for at most 300 ms instead', () => {
    const decided = plan({ reduceMotion: true });
    expect(decided).toEqual({ kind: 'static', holdMs: REDUCED_MOTION_MS });
    expect(REDUCED_MOTION_MS).toBeLessThanOrEqual(300);
  });

  it('leaves without a fade: a fade is motion too', () => {
    const decided = plan({ reduceMotion: true });
    expect(
      introStage({
        plan: decided,
        entranceDone: true,
        ready: true,
        readyWhenEntranceEnded: true,
        exitDone: false,
      }),
    ).toBe('gone');
  });
});

describe('the time bound', () => {
  it('is at most 1.2 s from first frame to the app, when the app is ready', () => {
    expect(INTRO_MAX_MS).toBeLessThanOrEqual(1200);
    for (const track of INTRO_TRACKS) {
      expect(
        track.delayMs + track.durationMs,
        `${track.target}.${track.property}`,
      ).toBeLessThanOrEqual(INTRO_SETTLED_MS);
    }
    expect(INTRO_SETTLED_MS + INTRO_EXIT.durationMs).toBe(INTRO_MAX_MS);
  });

  it('animates only opacity and transform', () => {
    for (const track of [...INTRO_TRACKS, INTRO_EXIT]) {
      expect(['opacity', 'scale', 'translateY']).toContain(track.property);
    }
  });

  it('ends on the original composition, fully shown', () => {
    for (const track of INTRO_TRACKS) expect(trackValueAt(track, INTRO_SETTLED_MS)).toBe(track.to);
    const opacityAtStart = INTRO_TRACKS.filter((t) => t.property === 'opacity').map((t) =>
      trackValueAt(t, 0),
    );
    expect(opacityAtStart).toEqual([0, 0]);
  });

  it('runs on the native driver, never loops, and makes no sound', () => {
    expect(INTRO_SOURCE).toMatch(/useNativeDriver: true/u);
    expect(INTRO_SOURCE).not.toMatch(/useNativeDriver: false/u);
    expect(INTRO_SOURCE).not.toMatch(/Animated\.loop|iterations/u);
    expect(INTRO_SOURCE).not.toMatch(/expo-av|expo-audio|Sound/u);
    // Built-in Animated only: no animation library.
    expect(INTRO_SOURCE).not.toMatch(/react-native-reanimated|lottie/u);
  });
});

describe('it never makes startup slower than max(animation, readiness)', () => {
  const animate = plan();
  const stage = (entranceDone: boolean, ready: boolean, readyWhenEntranceEnded = ready) =>
    introStage({ plan: animate, entranceDone, ready, readyWhenEntranceEnded, exitDone: false });

  it('plays while the session restores, whether or not it is ready yet', () => {
    expect(stage(false, false)).toBe('entrance');
    expect(stage(false, true)).toBe('entrance');
  });

  it('fades out at the end when the app was ready in time', () => {
    expect(stage(true, true, true)).toBe('exit');
    expect(
      introStage({
        plan: animate,
        entranceDone: true,
        ready: true,
        readyWhenEntranceEnded: true,
        exitDone: true,
      }),
    ).toBe('gone');
  });

  it('waits calmly on the final frame, never replaying, while the app is not ready', () => {
    expect(stage(true, false, false)).toBe('waiting');
    expect(INTRO_SOURCE).toMatch(/ActivityIndicator/u);
  });

  it('leaves the moment a late app is ready, adding no fade after it', () => {
    expect(stage(true, true, false)).toBe('gone');
  });

  it('draws nothing while deciding, and nothing at all when skipped', () => {
    expect(
      introStage({
        plan: null,
        entranceDone: false,
        ready: false,
        readyWhenEntranceEnded: false,
        exitDone: false,
      }),
    ).toBe('deciding');
    expect(
      introStage({
        plan: { kind: 'skip', reason: 'opened-by-link' },
        entranceDone: false,
        ready: false,
        readyWhenEntranceEnded: false,
        exitDone: false,
      }),
    ).toBe('gone');
  });
});

describe('accessibility', () => {
  it('hides the decoration and announces once, in the current language', () => {
    expect(INTRO_SOURCE).toMatch(/importantForAccessibility="no-hide-descendants"/u);
    expect(INTRO_SOURCE.match(/announceForAccessibility\(/gu)).toHaveLength(1);
    // After the stored language is restored, not before.
    expect(INTRO_SOURCE).toMatch(
      /restoreLanguage\(\)\.then\(\(\) => \{\s*AccessibilityInfo\.announceForAccessibility/u,
    );
  });
});

describe('the artwork', () => {
  it('takes where the wordmark lands from the shared, generated geometry', () => {
    // Checked against brand.json in packages/shared (brand.test.ts).
    expect(INTRO_SOURCE).toMatch(/= BRAND_ARTWORK;/u);
  });

  it('keeps every intro image under 200 KB', () => {
    for (const name of [
      'intro-illustration.jpg',
      'intro-illustration@2x.jpg',
      'intro-illustration@3x.jpg',
      'intro-wordmark.png',
      'intro-wordmark@2x.png',
      'intro-wordmark@3x.png',
    ]) {
      expect(statSync(file(`assets/brand/${name}`)).size, name).toBeLessThan(200 * 1024);
    }
  });
});
