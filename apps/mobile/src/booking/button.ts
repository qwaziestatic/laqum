import type { FixAccuracy } from '../location/fix.js';
import type { GateDecision } from '../location/gate.js';

/**
 * The Book screen's main button: what it says, and whether it can be pressed.
 *
 * It used to read `canBook ? 'Hold this slot' : 'Checking your location…'`,
 * so every state that was not "proceed" claimed a check was running. On the
 * device test the fix was too imprecise, nothing was running, and the button
 * still said it was checking. Each state now says what is actually true;
 * "Checking…" appears only while a check is in flight.
 */

export interface BookButtonState {
  /** The accuracy of the check in flight, or false when none is running. */
  locating: false | FixAccuracy;
  decision: GateDecision | null;
  /**
   * A location failure already explained on screen: 'blocked' for services
   * or permission (recovery is Settings), 'unavailable' when no fix came.
   */
  locationProblem: false | 'blocked' | 'unavailable';
  /** The booking request itself is in flight. */
  booking: boolean;
}

export interface BookButton {
  label: string;
  enabled: boolean;
}

export function bookButton(state: BookButtonState): BookButton {
  if (state.booking) return { label: 'Holding your slot…', enabled: false };
  if (state.locating === 'highest') {
    return { label: 'Getting a more precise location…', enabled: false };
  }
  if (state.locating === 'balanced') return { label: 'Checking your location…', enabled: false };
  if (state.locationProblem === 'blocked')
    return { label: 'Location needed to book', enabled: false };
  if (state.locationProblem === 'unavailable')
    return { label: 'Location unavailable', enabled: false };

  switch (state.decision?.kind) {
    case 'proceed':
      return { label: 'Hold this slot', enabled: true };
    case 'need_better_fix':
      return { label: 'Location not precise enough', enabled: false };
    case 'too_far':
      return { label: 'Too far from this lot', enabled: false };
    case 'stale':
      return { label: 'Location too old to use', enabled: false };
    case undefined:
      // Before the first check has started: it starts on mount.
      return { label: 'Checking your location…', enabled: false };
  }
}
