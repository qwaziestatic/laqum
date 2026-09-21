import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '@laqum/db';
import { AppError, type Clock, type UserRole } from '@laqum/shared';
import { SignJWT, jwtVerify } from 'jose';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';

/**
 * A short-lived JWT access token plus a rotating, revocable refresh token.
 *
 * Access tokens are stateless and never stored. Refresh tokens are random
 * secrets stored as an HMAC: the token itself never touches the database, but
 * the digest is DETERMINISTIC, so it can be looked up directly and can carry
 * the UNIQUE constraint the schema puts on refresh_tokens.token_hash. A salted
 * hash such as scrypt would make that lookup impossible.
 *
 * The token has 256 bits of entropy, so it needs no slow hash: there is
 * nothing to brute-force.
 */

const ISSUER = 'laqum';
const AUDIENCE = 'laqum-api';

export interface AccessClaims {
  userId: string;
  role: UserRole;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

function secretOf(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export async function signAccessToken(
  config: Config,
  clock: Clock,
  claims: AccessClaims,
): Promise<{ token: string; expiresAt: Date }> {
  const issuedAt = clock.now();
  const expiresAt = new Date(issuedAt.getTime() + config.ACCESS_TOKEN_TTL_MINUTES * 60_000);

  const token = await new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    // Seconds, from the injected clock — not jose's own "2h"-style helpers,
    // which would read the real clock and ignore FakeClock.
    .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretOf(config.JWT_ACCESS_SECRET));

  return { token, expiresAt };
}

export async function verifyAccessToken(
  config: Config,
  clock: Clock,
  token: string,
): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, secretOf(config.JWT_ACCESS_SECRET), {
      issuer: ISSUER,
      audience: AUDIENCE,
      // jose defaults to Date.now(); the injected clock is what makes
      // expiry testable without waiting.
      currentDate: clock.now(),
    });

    const role = payload['role'];
    if (typeof payload.sub !== 'string' || typeof role !== 'string') {
      throw new AppError('UNAUTHENTICATED', 'Malformed token');
    }
    return { userId: payload.sub, role: role as UserRole };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('UNAUTHENTICATED', 'Invalid or expired access token');
  }
}

/** The opaque secret handed to the client. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Deterministic, so the digest can be looked up and uniquely indexed. */
export function hashRefreshToken(config: Config, token: string): string {
  return createHmac('sha256', config.JWT_REFRESH_SECRET).update(token).digest('hex');
}

export function refreshTokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function issueTokenPair(
  db: Kysely<Database>,
  config: Config,
  clock: Clock,
  claims: AccessClaims,
): Promise<TokenPair> {
  const { token: accessToken, expiresAt: accessExpiresAt } = await signAccessToken(
    config,
    clock,
    claims,
  );

  const refreshToken = generateRefreshToken();
  const refreshExpiresAt = new Date(
    clock.now().getTime() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  );

  await db
    .insertInto('refresh_tokens')
    .values({
      user_id: claims.userId,
      token_hash: hashRefreshToken(config, refreshToken),
      expires_at: refreshExpiresAt,
      created_at: clock.now(),
    })
    .execute();

  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}
