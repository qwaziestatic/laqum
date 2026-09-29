/**
 * Asking for notification permission at the RIGHT moment.
 *
 * Not at launch. A permission prompt on first open, before the driver has
 * seen what the app does, is the reliable way to get a permanent "no" — and
 * on both platforms a denied notification permission cannot be re-requested
 * in-app, only through Settings. One badly-timed prompt costs the channel for
 * good.
 *
 * So the ask comes AFTER the first successful booking, when the value is
 * concrete and immediate: the driver now has a slot held on a timer and an
 * obvious reason to want to be told before it expires. One line of
 * explanation, then the system prompt.
 *
 * The API sends the hold warnings, time reminders, overstay and amount-due
 * notices (apps/api/src/push/notify.ts), in the language registered with the
 * token. usePush.ts registers again, never prompting, when that changes.
 */

import { type BookingStatus, isLiveStatus } from '@laqum/shared';

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

/**
 * Whether the booking on screen makes NOW the moment to ask: the driver holds
 * a slot on a timer (RESERVED, CHECKED_IN, OVERSTAY).
 *
 * The booking screen used to pass a constant `true`, so the gate below never
 * decided anything, and opening an old expired or cancelled booking counted as
 * "has booked". Not while PENDING_PAYMENT either: the slot is not held yet,
 * and the Chapa checkout is open over the app. On Android a permission
 * request always launches the permission activity (CLAUDE.md), which would
 * land in the middle of paying.
 */
export function bookingEarnsPushAsk(status: BookingStatus): boolean {
  return isLiveStatus(status) && status !== 'PENDING_PAYMENT';
}

/**
 * Waits between token attempts once permission is granted: 2, 5, 15, 30 s.
 *
 * Session 3 on the phone: notifications were allowed, but the token reached
 * the server five minutes later, when another screen asked again, so the
 * first booking's notice was lost. The first token fetch after the grant had
 * failed and nothing retried. Bounded: about a minute, then the next return
 * to the foreground tries again (usePush.ts).
 */
export const TOKEN_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];

export interface PushDeps {
  getPermissions: () => Promise<PermissionStatus>;
  requestPermissions: () => Promise<PermissionStatus>;
  /** null when no token could be had; the reason is logged there. */
  getToken: () => Promise<string | null>;
  /** Injected so the retry is tested without waiting. */
  sleep: (ms: number) => Promise<void>;
  /** POSTs the token to the API, which stores it in push_tokens. */
  upload: (token: string) => Promise<void>;
  /** Whether the driver holds a booked slot now: see bookingEarnsPushAsk. */
  hasBooked: () => Promise<boolean>;
}

export type RegistrationOutcome =
  | { kind: 'registered'; token: string }
  | { kind: 'too_early' }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

/**
 * Decide whether to ask, ask if so, and register the token.
 *
 * Returns rather than throws, because every outcome here is normal: a driver
 * who declines notifications still gets a working app, and the UI must not
 * treat that as an error.
 */
/** The token, retried after each delay while none comes. Never prompts. */
async function tokenWithRetry(deps: PushDeps): Promise<string | null> {
  let token = await deps.getToken();
  for (const delay of TOKEN_RETRY_DELAYS_MS) {
    if (token) break;
    await deps.sleep(delay);
    token = await deps.getToken();
  }
  return token;
}

export async function maybeRegisterForPush(deps: PushDeps): Promise<RegistrationOutcome> {
  // Already granted on a previous run: refresh the token silently. Tokens
  // rotate, so this is not a no-op.
  const existing = await deps.getPermissions();
  if (existing === 'granted') {
    const token = await tokenWithRetry(deps);
    if (!token) return { kind: 'unavailable' };
    await deps.upload(token);
    return { kind: 'registered', token };
  }

  // Previously refused. Asking again does nothing on either platform, so do
  // not pretend otherwise — Settings is the only route back.
  if (existing === 'denied') return { kind: 'denied' };

  // THE GATE: no booking yet means no reason for the driver to say yes.
  if (!(await deps.hasBooked())) return { kind: 'too_early' };

  const status = await deps.requestPermissions();
  if (status !== 'granted') return { kind: 'denied' };

  const token = await tokenWithRetry(deps);
  if (!token) return { kind: 'unavailable' };
  await deps.upload(token);
  return { kind: 'registered', token };
}
