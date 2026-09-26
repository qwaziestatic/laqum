/**
 * THE DASHBOARD'S OPENING ANIMATION: whether it plays, and for how long. Pure.
 *
 * The product owner's rules: the driver app's motion language in at most
 * 800 ms; once per browser session, not on every reload and never on a
 * realtime reconnect; never delaying sign-in or the connection, which start
 * underneath it at the same moment; prefers-reduced-motion respected.
 *
 * It is decided once per PAGE LOAD (main.tsx), outside React: a reconnect
 * never re-runs main.tsx, and React's strict mode cannot run it twice.
 * The motion itself is CSS (index.css, "Opening animation"); intro.test.ts
 * checks the stylesheet against INTRO_MS.
 */

export const INTRO_MS = 800;
export const REDUCED_MOTION_MS = 300;
export const INTRO_SESSION_KEY = 'laqum:intro-shown';

export interface IntroPlan {
  reducedMotion: boolean;
  /** How long the overlay exists, from first frame to removal. */
  durationMs: number;
}

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Plays once per browser session. Marked as shown the moment it starts, so a
 * reload halfway through does not replay it. Without usable storage it does
 * not play at all: it could not remember, and replaying on every reload
 * would cost an attendant under pressure more than the animation is worth.
 */
export function planIntro(session: SessionStore | null, reducedMotion: boolean): IntroPlan | null {
  if (session === null) return null;
  try {
    if (session.getItem(INTRO_SESSION_KEY) !== null) return null;
    session.setItem(INTRO_SESSION_KEY, '1');
  } catch {
    return null;
  }
  return { reducedMotion, durationMs: reducedMotion ? REDUCED_MOTION_MS : INTRO_MS };
}

/** The browser's session storage, or null where reading it throws. */
export function browserSession(): SessionStore | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
