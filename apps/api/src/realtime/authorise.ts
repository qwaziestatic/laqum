import type { Database } from '@laqum/db';
import type { Clock } from '@laqum/shared';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import { type VerifiedAccessToken, verifyAccessToken } from '../auth/tokens.js';

/**
 * SOCKET AUTHORIZATION MUST NOT OUTLIVE ITS BASIS.
 *
 * An HTTP request re-authorises itself: the token is verified and the lot
 * membership is read on every call, so revoking either takes effect on the
 * next request. A socket is different in kind. It is authorised ONCE at the
 * handshake and then stays open for hours, so without deliberate effort it
 * keeps whatever authority it was granted long after the grounds for it are
 * gone — a sacked attendant would keep receiving live plates.
 *
 * Two mechanisms, for the two things that can change:
 *
 *   1. THE TOKEN EXPIRES. The connection is closed at the moment `exp` passes,
 *      so socket authority never outlasts the credential it came from. The
 *      client reconnects with a fresh token; the store discards its grid and
 *      waits for a new snapshot, so no update is silently missed.
 *
 *   2. MEMBERSHIP IS REVOKED. lot_staff is re-read on EVERY subscribe, never
 *      cached from the handshake. That covers the reconnect case for free: a
 *      reconnect is a new handshake followed by a new subscribe, so a socket
 *      cannot re-enter a staff room it is no longer entitled to.
 *
 * Neither mechanism trusts the client. Both are enforced here, server-side.
 */

export interface SocketPrincipal extends VerifiedAccessToken {
  /** Milliseconds from now until the token expires; never negative. */
  ttlMs: number;
}

export type AuthoriseFailure =
  | { ok: false; reason: 'NO_TOKEN' }
  | { ok: false; reason: 'BAD_TOKEN' }
  | { ok: false; reason: 'EXPIRED' };

export type AuthoriseResult = { ok: true; principal: SocketPrincipal } | AuthoriseFailure;

/**
 * Authorise a handshake.
 *
 * The token is read from the handshake `auth` payload rather than a query
 * string: query strings are logged by proxies and land in browser history,
 * and this is a live credential.
 */
export async function authoriseHandshake(
  config: Config,
  clock: Clock,
  token: unknown,
): Promise<AuthoriseResult> {
  if (typeof token !== 'string' || token.trim().length === 0) {
    return { ok: false, reason: 'NO_TOKEN' };
  }

  let claims: VerifiedAccessToken;
  try {
    claims = await verifyAccessToken(config, clock, token);
  } catch {
    return { ok: false, reason: 'BAD_TOKEN' };
  }

  const ttlMs = claims.expiresAt.getTime() - clock.now().getTime();
  if (ttlMs <= 0) {
    // verifyAccessToken should already have refused this; checking again
    // costs nothing and means a zero or negative timer can never be armed.
    return { ok: false, reason: 'EXPIRED' };
  }

  return { ok: true, principal: { ...claims, ttlMs } };
}

/**
 * Is this user staff at this lot, RIGHT NOW?
 *
 * Deliberately not memoised. The whole point is that the answer is allowed to
 * change between one subscribe and the next, so an answer cached at handshake
 * would reintroduce exactly the staleness this module exists to prevent.
 */
export async function isLotStaff(
  db: Kysely<Database>,
  userId: string,
  lotId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('lot_staff')
    .select('lot_id')
    .where('lot_id', '=', lotId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * setTimeout clamps delays above 2^31-1 ms (~24.9 days) to 1 ms, which would
 * disconnect a long-lived token IMMEDIATELY rather than never. Access tokens
 * are minutes long so this cannot bite today, but the failure would look like
 * "sockets drop instantly" and take an afternoon to find, so it is capped.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export function expiryDelayMs(ttlMs: number): number {
  return Math.min(Math.max(ttlMs, 0), MAX_TIMEOUT_MS);
}
