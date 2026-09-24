import { describe, expect, it } from 'vitest';
import { bookButton, type BookButtonState } from '../src/booking/button.js';
import type { GateDecision } from '../src/location/gate.js';

/**
 * The Book screen's button. On the device test the fix was too imprecise,
 * nothing was running, and the disabled button said "Checking your
 * location…": every non-proceed state used that one label.
 */

const IDLE: BookButtonState = {
  locating: false,
  decision: null,
  locationProblem: false,
  booking: false,
};

const decision = {
  proceed: { kind: 'proceed', distanceM: 20, accuracyM: 10 },
  needBetterFix: { kind: 'need_better_fix', distanceM: 990, accuracyM: 60, limitM: 1000 },
  tooFar: { kind: 'too_far', distanceM: 1400, accuracyM: 10, limitM: 1000 },
  stale: { kind: 'stale', ageMs: 120_000 },
} satisfies Record<string, GateDecision>;

describe('bookButton', () => {
  it('says the fix is not precise enough — not "checking" — when nothing is running', () => {
    const button = bookButton({ ...IDLE, decision: decision.needBetterFix });

    expect(button).toEqual({ label: 'Location not precise enough', enabled: false });
    expect(button.label).not.toMatch(/checking/iu);
  });

  it('claims a check is running only while one is', () => {
    const idleStates: BookButtonState[] = [
      { ...IDLE, decision: decision.proceed },
      { ...IDLE, decision: decision.needBetterFix },
      { ...IDLE, decision: decision.tooFar },
      { ...IDLE, decision: decision.stale },
      { ...IDLE, locationProblem: 'blocked' },
      { ...IDLE, locationProblem: 'unavailable' },
    ];
    for (const state of idleStates) {
      expect(bookButton(state).label, JSON.stringify(state)).not.toMatch(/checking|getting/iu);
    }

    expect(bookButton({ ...IDLE, locating: 'balanced' }).label).toBe('Checking your location…');
    expect(bookButton({ ...IDLE, locating: 'highest', decision: decision.needBetterFix })).toEqual({
      label: 'Getting a more precise location…',
      enabled: false,
    });
  });

  it('states each reason it cannot book', () => {
    expect(bookButton({ ...IDLE, decision: decision.tooFar }).label).toBe('Too far from this lot');
    expect(bookButton({ ...IDLE, decision: decision.stale }).label).toBe('Location too old to use');
    expect(bookButton({ ...IDLE, locationProblem: 'blocked' }).label).toBe(
      'Location needed to book',
    );
    expect(bookButton({ ...IDLE, locationProblem: 'unavailable' }).label).toBe(
      'Location unavailable',
    );
  });

  it('enables the button on "proceed" alone', () => {
    const enabled = [
      IDLE,
      { ...IDLE, decision: decision.proceed },
      { ...IDLE, decision: decision.needBetterFix },
      { ...IDLE, decision: decision.tooFar },
      { ...IDLE, decision: decision.stale },
      { ...IDLE, decision: decision.proceed, locating: 'balanced' as const },
      { ...IDLE, decision: decision.proceed, booking: true },
    ].filter((state) => bookButton(state).enabled);

    expect(enabled).toEqual([{ ...IDLE, decision: decision.proceed }]);
    expect(bookButton({ ...IDLE, decision: decision.proceed }).label).toBe('Hold this slot');
  });

  it('shows the booking in flight over everything else', () => {
    expect(bookButton({ ...IDLE, decision: decision.proceed, booking: true })).toEqual({
      label: 'Holding your slot…',
      enabled: false,
    });
  });

  it('says it is checking before the first check has reported', () => {
    // The first check starts on mount; nothing to state yet.
    expect(bookButton(IDLE)).toEqual({ label: 'Checking your location…', enabled: false });
  });
});
