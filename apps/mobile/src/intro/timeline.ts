/**
 * THE OPENING ANIMATION: what plays, when, and for how long. Pure.
 *
 * Intro.tsx renders it; test/intro.test.ts checks the rules; and
 * scripts/brand/previews.mjs draws the review frames from the same numbers.
 * That is why this file imports nothing: Node loads it directly.
 *
 * The rules, from the product owner:
 * - cold start only: never on a return to the foreground, never when the
 *   app was opened by a link (returning from the checkout, say);
 * - at most 1.2 s, opacity and transform only, on the native driver, no
 *   loop and no sound;
 * - in parallel with the session restore: it never makes startup slower than
 *   max(animation, readiness), and if the app is still not ready when it
 *   ends, a calm static frame waits instead of a replay;
 * - reduced motion: one static frame for at most 300 ms.
 */

export const INTRO_MAX_MS = 1200;
export const REDUCED_MOTION_MS = 300;

export type IntroTarget = 'illustration' | 'wordmark' | 'overlay';
/** The only properties the intro animates: all the native driver can run. */
export type IntroProperty = 'opacity' | 'scale' | 'translateY';

export interface IntroTrack {
  target: IntroTarget;
  property: IntroProperty;
  from: number;
  to: number;
  delayMs: number;
  durationMs: number;
  /** Decelerating, so things arrive and settle rather than stop. */
  easing: 'out-cubic' | 'in-quad';
}

/**
 * The illustration fades and scales in gently; then the wordmark settles
 * into its place; then, if the app is ready, the whole overlay fades out.
 */
export const INTRO_TRACKS: readonly IntroTrack[] = [
  {
    target: 'illustration',
    property: 'opacity',
    from: 0,
    to: 1,
    delayMs: 0,
    durationMs: 550,
    easing: 'out-cubic',
  },
  {
    target: 'illustration',
    property: 'scale',
    from: 0.94,
    to: 1,
    delayMs: 0,
    durationMs: 550,
    easing: 'out-cubic',
  },
  {
    target: 'wordmark',
    property: 'opacity',
    from: 0,
    to: 1,
    delayMs: 450,
    durationMs: 500,
    easing: 'out-cubic',
  },
  {
    target: 'wordmark',
    property: 'translateY',
    from: 14,
    to: 0,
    delayMs: 450,
    durationMs: 500,
    easing: 'out-cubic',
  },
];

/** When the entrance is complete: the final frame, held until the exit. */
export const INTRO_SETTLED_MS = 1000;

/** The exit: the overlay fades to reveal the app. Only once the app is ready. */
export const INTRO_EXIT: IntroTrack = {
  target: 'overlay',
  property: 'opacity',
  from: 1,
  to: 0,
  delayMs: 0,
  durationMs: INTRO_MAX_MS - INTRO_SETTLED_MS,
  easing: 'in-quad',
};

export function easingValue(easing: IntroTrack['easing'], t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return easing === 'out-cubic' ? 1 - (1 - x) ** 3 : x * x;
}

/** A track's value at a moment of the entrance, for the review frames. */
export function trackValueAt(track: IntroTrack, ms: number): number {
  const t = (ms - track.delayMs) / track.durationMs;
  return track.from + (track.to - track.from) * easingValue(track.easing, t);
}

// ─── Whether it plays ──────────────────────────────────────────────────────

export type IntroPlan =
  | { kind: 'skip'; reason: 'not-cold-start' | 'opened-by-link' | 'undecided' }
  | { kind: 'static'; holdMs: number }
  | { kind: 'animate'; entranceMs: number; totalMs: number };

/**
 * Was the app opened BY a link to it? The app's own scheme is a link; the
 * development client's launcher URL (exp+laqum://expo-development-client…)
 * is not, and neither is no URL at all (a tap on the icon).
 */
export function openedByLink(initialUrl: string | null, appScheme: string): boolean {
  if (!initialUrl) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(initialUrl)?.[1]?.toLowerCase();
  return scheme === appScheme.toLowerCase();
}

export function introPlan(input: {
  coldStart: boolean;
  initialUrl: string | null;
  appScheme: string;
  reduceMotion: boolean;
}): IntroPlan {
  if (!input.coldStart) return { kind: 'skip', reason: 'not-cold-start' };
  if (openedByLink(input.initialUrl, input.appScheme))
    return { kind: 'skip', reason: 'opened-by-link' };
  if (input.reduceMotion) return { kind: 'static', holdMs: REDUCED_MOTION_MS };
  return { kind: 'animate', entranceMs: INTRO_SETTLED_MS, totalMs: INTRO_MAX_MS };
}

/**
 * What the overlay shows now. The entrance and the session restore run side
 * by side, and the overlay is gone by max(INTRO_MAX_MS, ready), never later:
 *
 * - ready before the entrance ends: the exit fade runs, finishing at 1.2 s;
 * - ready later: the final frame waits (with an activity indicator, never a
 *   replay) and leaves the moment the app is ready, with no fade to add;
 * - reduced motion: never a fade, which is motion too.
 */
export type IntroStage = 'deciding' | 'entrance' | 'waiting' | 'exit' | 'gone';

export function introStage(input: {
  plan: IntroPlan | null;
  entranceDone: boolean;
  ready: boolean;
  /** Whether the app was already ready at the moment the entrance ended. */
  readyWhenEntranceEnded: boolean;
  exitDone: boolean;
}): IntroStage {
  const { plan } = input;
  if (plan === null) return 'deciding';
  if (plan.kind === 'skip' || input.exitDone) return 'gone';
  if (!input.entranceDone) return 'entrance';
  if (!input.ready) return 'waiting';
  return plan.kind === 'animate' && input.readyWhenEntranceEnded ? 'exit' : 'gone';
}

/**
 * Cold start = the first time in this JavaScript runtime. A return to the
 * foreground does not remount the root; reopening after Back does, in the
 * same runtime, and is a warm start. Either way the flag is already taken.
 */
let coldStartClaimed = false;
export function claimColdStart(): boolean {
  if (coldStartClaimed) return false;
  coldStartClaimed = true;
  return true;
}
/** Tests only. */
export function resetColdStartForTests(): void {
  coldStartClaimed = false;
}

// ─── Layout ────────────────────────────────────────────────────────────────

/** The card the illustration sits on: centred, with the phone's margins. */
export function introCard(screenWidth: number): { width: number; padding: number; radius: number } {
  const width = Math.min(screenWidth - 2 * 24, 420);
  return { width, padding: 16, radius: 20 };
}
