/**
 * Can this fix decide the TOO_FAR question?
 *
 * The naive rule is "reject any fix worse than 100m", which is wrong in both
 * directions: it rejects a 120m fix taken while standing in the lot (where the
 * answer is obvious), and it accepts a 90m fix taken 95m from a lot with a
 * 100m radius (where it decides nothing).
 *
 * The question is not how good the fix is, it is whether the UNCERTAINTY COULD
 * CHANGE THE ANSWER. With
 *
 *     d = distance from the fix to the lot
 *     a = the fix's reported accuracy (radius of uncertainty, metres)
 *     r = the lot's max_booking_distance_m
 *
 *     d + a <= r   → inside even in the worst case          → PROCEED
 *     d - a >  r   → outside even in the best case          → TOO_FAR, locally
 *     otherwise    → the uncertainty straddles the boundary → NEED A BETTER FIX
 *
 * THE SERVER REMAINS THE AUTHORITY. This only decides whether it is worth
 * asking, and lets the app say "you are too far" with real numbers instead of
 * a round trip. A PROCEED here can still come back TOO_FAR from the API, and
 * that answer wins.
 */

/** How old a fix may be before it is refused outright. */
export const MAX_FIX_AGE_MS = 60_000;

export interface Fix {
  latitude: number;
  longitude: number;
  /** Radius of 68% confidence, in metres, as reported by the platform. */
  accuracyM: number;
  /** Epoch millis from the location provider. */
  timestampMs: number;
}

export type GateDecision =
  | { kind: 'proceed'; distanceM: number; accuracyM: number }
  | { kind: 'too_far'; distanceM: number; accuracyM: number; limitM: number }
  | { kind: 'need_better_fix'; distanceM: number; accuracyM: number; limitM: number }
  | { kind: 'stale'; ageMs: number };

export interface GateInput {
  /** Distance from the fix to the lot, metres — from the shared haversine. */
  distanceM: number;
  accuracyM: number;
  /** The lot's max_booking_distance_m. */
  limitM: number;
}

/**
 * Decide, given a distance already computed against the lot.
 *
 * Split from the fix so the rule is testable without coordinates, and so the
 * caller uses the SAME haversine the server does (from @laqum/shared) rather
 * than a second implementation that could disagree at the boundary.
 */
export function decide(input: GateInput): GateDecision {
  const { distanceM, accuracyM, limitM } = input;

  // A platform that reports no accuracy is treated as maximally uncertain
  // rather than perfectly certain — the safe direction.
  const a = Number.isFinite(accuracyM) && accuracyM >= 0 ? accuracyM : Number.POSITIVE_INFINITY;

  if (distanceM + a <= limitM) {
    return { kind: 'proceed', distanceM, accuracyM: a };
  }
  if (distanceM - a > limitM) {
    return { kind: 'too_far', distanceM, accuracyM: a, limitM };
  }
  return { kind: 'need_better_fix', distanceM, accuracyM: a, limitM };
}

/** The full check, including the staleness rule. */
export function gate(fix: Fix, input: GateInput, nowMs: number): GateDecision {
  const ageMs = nowMs - fix.timestampMs;
  /*
   * Staleness first, and before the geometry.
   *
   * A cached fix from twenty minutes ago may be perfectly accurate about where
   * the phone WAS. Accuracy says nothing about age, so no amount of precision
   * rescues a stale fix — the driver may have driven three kilometres since.
   */
  if (ageMs > MAX_FIX_AGE_MS) {
    return { kind: 'stale', ageMs };
  }
  return decide(input);
}
