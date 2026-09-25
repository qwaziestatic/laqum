import type { FixAccuracy } from '../location/fix.js';
import type { GateDecision } from '../location/gate.js';
import type { MessageKey } from '../i18n/core.js';

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
  /** A translation key. */
  label: MessageKey;
  enabled: boolean;
}

export function bookButton(state: BookButtonState): BookButton {
  if (state.booking) return { label: 'book.button.holding', enabled: false };
  if (state.locating === 'highest') {
    return { label: 'book.button.precise', enabled: false };
  }
  if (state.locating === 'balanced') return { label: 'book.button.checking', enabled: false };
  if (state.locationProblem === 'blocked')
    return { label: 'book.button.locationNeeded', enabled: false };
  if (state.locationProblem === 'unavailable')
    return { label: 'book.button.locationUnavailable', enabled: false };

  switch (state.decision?.kind) {
    case 'proceed':
      return { label: 'book.button.hold', enabled: true };
    case 'need_better_fix':
      return { label: 'book.button.notPrecise', enabled: false };
    case 'too_far':
      return { label: 'book.button.tooFar', enabled: false };
    case 'stale':
      return { label: 'book.button.tooOld', enabled: false };
    case undefined:
      // Before the first check has started: it starts on mount.
      return { label: 'book.button.checking', enabled: false };
  }
}
