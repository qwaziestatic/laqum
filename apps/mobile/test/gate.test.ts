import { describe, expect, it } from 'vitest';
import { MAX_FIX_AGE_MS, decide, gate, type Fix } from '../src/location/gate.js';

/**
 * The three branches, and the boundaries between them.
 *
 * The rule is about whether the UNCERTAINTY could change the answer, not about
 * whether the fix is "good". Each branch is tested at its edge, because that
 * is where a >= / > slip hides.
 */

const LIMIT = 100;

describe('the uncertainty decides, not the accuracy alone', () => {
  it('PROCEEDS when inside even in the worst case', () => {
    // 40m away, ±30m → at worst 70m, still inside 100m.
    expect(decide({ distanceM: 40, accuracyM: 30, limitM: LIMIT })).toMatchObject({
      kind: 'proceed',
    });
  });

  it('PROCEEDS on a poor fix when it is obviously inside', () => {
    // The naive "<=100m accuracy" rule would REFUSE this, though standing in
    // the lot with a 120m fix decides the question perfectly well.
    expect(decide({ distanceM: 5, accuracyM: 80, limitM: LIMIT })).toMatchObject({
      kind: 'proceed',
    });
  });

  it('reports TOO_FAR when outside even in the best case', () => {
    // 300m away, ±50m → at best 250m, still beyond 100m.
    const result = decide({ distanceM: 300, accuracyM: 50, limitM: LIMIT });
    expect(result).toMatchObject({ kind: 'too_far', distanceM: 300, limitM: LIMIT });
  });

  it('asks for a BETTER FIX when the uncertainty straddles the limit', () => {
    // 95m away, ±20m → anywhere from 75m to 115m. The fix cannot answer.
    expect(decide({ distanceM: 95, accuracyM: 20, limitM: LIMIT })).toMatchObject({
      kind: 'need_better_fix',
    });
  });

  it('asks for a better fix on a good fix that still decides nothing', () => {
    // The naive rule would ACCEPT this 10m fix and send a request that may be
    // wrong; 95±10 straddles 100.
    expect(decide({ distanceM: 95, accuracyM: 10, limitM: LIMIT })).toMatchObject({
      kind: 'need_better_fix',
    });
  });
});

describe('boundaries', () => {
  it('proceeds when d + a lands exactly on the limit', () => {
    expect(decide({ distanceM: 70, accuracyM: 30, limitM: LIMIT }).kind).toBe('proceed');
  });

  it('does not proceed one metre past it', () => {
    expect(decide({ distanceM: 71, accuracyM: 30, limitM: LIMIT }).kind).toBe('need_better_fix');
  });

  it('is NOT too_far when d - a lands exactly on the limit', () => {
    // 150 - 50 = 100, which is not "> 100": the driver could be exactly at the
    // boundary, so this is still undecided rather than a refusal.
    expect(decide({ distanceM: 150, accuracyM: 50, limitM: LIMIT }).kind).toBe('need_better_fix');
  });

  it('is too_far one metre past that', () => {
    expect(decide({ distanceM: 151, accuracyM: 50, limitM: LIMIT }).kind).toBe('too_far');
  });

  it('treats a missing accuracy as maximally uncertain, never as certain', () => {
    // Some platforms report -1 or NaN. Assuming perfect accuracy there would
    // send a confident request built on nothing.
    for (const accuracyM of [-1, Number.NaN]) {
      expect(decide({ distanceM: 5, accuracyM, limitM: LIMIT }).kind).toBe('need_better_fix');
    }
  });
});

describe('staleness is independent of accuracy', () => {
  const fix = (timestampMs: number): Fix => ({
    latitude: 9.0348,
    longitude: 38.7508,
    accuracyM: 5,
    timestampMs,
  });
  const now = 1_800_000_000_000;

  it('accepts a fresh fix', () => {
    const result = gate(fix(now - 10_000), { distanceM: 10, accuracyM: 5, limitM: LIMIT }, now);
    expect(result.kind).toBe('proceed');
  });

  it('REFUSES a stale fix however accurate it is', () => {
    /*
     * A ±5m fix from twenty minutes ago is precise about where the phone WAS.
     * Accuracy says nothing about age, so precision cannot rescue it.
     */
    const result = gate(
      fix(now - 20 * 60_000),
      { distanceM: 10, accuracyM: 5, limitM: LIMIT },
      now,
    );
    expect(result).toMatchObject({ kind: 'stale' });
  });

  it('checks staleness BEFORE the geometry', () => {
    // Even an obviously-inside fix is refused when it is too old, rather than
    // proceeding on data that predates the drive.
    const result = gate(fix(now - 10 * 60_000), { distanceM: 1, accuracyM: 1, limitM: LIMIT }, now);
    expect(result.kind).toBe('stale');
  });

  it('accepts a fix exactly at the age limit', () => {
    const result = gate(
      fix(now - MAX_FIX_AGE_MS),
      { distanceM: 10, accuracyM: 5, limitM: LIMIT },
      now,
    );
    expect(result.kind).toBe('proceed');
  });
});
