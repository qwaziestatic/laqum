import type { Database } from '@laqum/db';
import { AppError, type Clock, type UserRole, addMinutes } from '@laqum/shared';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { RateLimiter } from './rateLimit.js';
import { generateOtp, hashOtp, verifyOtp } from './otp.js';
import type { SmsProvider } from './sms.js';
import { hashRefreshToken, issueTokenPair, type TokenPair } from './tokens.js';

export interface AuthDeps {
  db: Kysely<Database>;
  clock: Clock;
  config: Config;
  logger: Logger;
  sms: SmsProvider;
  rateLimiter: RateLimiter;
}

export interface SessionUser {
  id: string;
  phone: string;
  role: UserRole;
  fullName: string | null;
}

export interface Session extends TokenPair {
  user: SessionUser;
}

/**
 * Request an OTP.
 *
 * Rate limited per phone AND per IP: the phone limit stops one number being
 * spammed, the IP limit stops one caller enumerating many numbers.
 */
export async function requestOtp(
  deps: AuthDeps,
  input: { phone: string; ip: string },
): Promise<{ expiresAt: Date }> {
  const window = deps.config.OTP_RATE_LIMIT_WINDOW_MINUTES;

  const perPhone = await deps.rateLimiter.hit(
    `otp:phone:${input.phone}`,
    deps.config.OTP_RATE_LIMIT_PER_PHONE,
    window,
  );
  if (!perPhone.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many codes requested for this number', {
      retryAt: perPhone.resetAt.toISOString(),
    });
  }

  const perIp = await deps.rateLimiter.hit(
    `otp:ip:${input.ip}`,
    deps.config.OTP_RATE_LIMIT_PER_IP,
    window,
  );
  if (!perIp.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many codes requested from this device', {
      retryAt: perIp.resetAt.toISOString(),
    });
  }

  const now = deps.clock.now();
  const code = generateOtp();
  const expiresAt = addMinutes(now, deps.config.OTP_TTL_MINUTES);

  await deps.db
    .insertInto('otp_codes')
    .values({
      phone: input.phone,
      code_hash: await hashOtp(code),
      expires_at: expiresAt,
      // Explicit, not the column default: otp_codes are ordered by created_at
      // and the fake clock must drive that ordering.
      created_at: now,
    })
    .execute();

  await deps.sms.send(input.phone, `Your ላቁም? code is ${code}. It expires in 5 minutes.`);

  return { expiresAt };
}

/**
 * Verify an OTP and start a session.
 *
 * Only the most recent unconsumed code for the phone is considered: requesting
 * a new code must invalidate the previous one, or a leaked older code stays
 * usable for its whole five minutes.
 */
export async function verifyOtpAndSignIn(
  deps: AuthDeps,
  input: { phone: string; code: string },
): Promise<Session> {
  const now = deps.clock.now();

  const record = await deps.db
    .selectFrom('otp_codes')
    .selectAll()
    .where('phone', '=', input.phone)
    .where('consumed_at', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  if (!record) {
    throw new AppError('OTP_INVALID', 'No code was requested for this number');
  }

  if (record.expires_at.getTime() <= now.getTime()) {
    throw new AppError('OTP_EXPIRED', 'That code has expired. Request a new one.');
  }

  if (record.attempts >= deps.config.OTP_MAX_ATTEMPTS) {
    throw new AppError('OTP_TOO_MANY_ATTEMPTS', 'Too many attempts. Request a new code.');
  }

  if (!(await verifyOtp(input.code, record.code_hash))) {
    // Count the failure before returning, so a brute force burns attempts.
    await deps.db
      .updateTable('otp_codes')
      .set({ attempts: record.attempts + 1 })
      .where('id', '=', record.id)
      .execute();

    const remaining = deps.config.OTP_MAX_ATTEMPTS - (record.attempts + 1);
    throw new AppError('OTP_INVALID', 'That code is not correct', { attemptsRemaining: remaining });
  }

  await deps.db
    .updateTable('otp_codes')
    .set({ consumed_at: now })
    .where('id', '=', record.id)
    .execute();

  const user = await findOrCreateUser(deps, input.phone);

  // A successful sign-in should not leave the caller rate limited.
  await deps.rateLimiter.reset(
    `otp:phone:${input.phone}`,
    deps.config.OTP_RATE_LIMIT_WINDOW_MINUTES,
  );

  const tokens = await issueTokenPair(deps.db, deps.config, deps.clock, {
    userId: user.id,
    role: user.role,
  });

  return { ...tokens, user };
}

/** First sign-in creates the account. Staff roles are assigned by an admin. */
async function findOrCreateUser(deps: AuthDeps, phone: string): Promise<SessionUser> {
  const existing = await deps.db
    .selectFrom('users')
    .select(['id', 'phone', 'role', 'full_name'])
    .where('phone', '=', phone)
    .executeTakeFirst();

  if (existing) {
    return {
      id: existing.id,
      phone: existing.phone,
      role: existing.role,
      fullName: existing.full_name,
    };
  }

  const created = await deps.db
    .insertInto('users')
    .values({ phone, role: 'driver', created_at: deps.clock.now() })
    .returning(['id', 'phone', 'role', 'full_name'])
    .executeTakeFirstOrThrow();

  return {
    id: created.id,
    phone: created.phone,
    role: created.role,
    fullName: created.full_name,
  };
}

/**
 * Rotate a refresh token.
 *
 * The presented token is revoked and a new pair issued, so a stolen token is
 * usable at most once before the legitimate client's next refresh invalidates
 * it. Reuse DETECTION (revoking the whole family on replay) is not implemented;
 * it is a hardening item, not part of this phase.
 */
export async function refreshSession(deps: AuthDeps, refreshToken: string): Promise<Session> {
  const now = deps.clock.now();
  const hash = hashRefreshToken(deps.config, refreshToken);

  const record = await deps.db
    .selectFrom('refresh_tokens')
    .selectAll()
    .where('token_hash', '=', hash)
    .executeTakeFirst();

  if (!record) {
    throw new AppError('UNAUTHENTICATED', 'That refresh token is not usable');
  }
  if (record.revoked_at !== null || record.expires_at.getTime() <= now.getTime()) {
    throw new AppError('UNAUTHENTICATED', 'That refresh token is not usable');
  }

  const user = await deps.db
    .selectFrom('users')
    .select(['id', 'phone', 'role', 'full_name'])
    .where('id', '=', record.user_id)
    .executeTakeFirst();

  if (!user) {
    throw new AppError('UNAUTHENTICATED', 'That account no longer exists');
  }

  await deps.db
    .updateTable('refresh_tokens')
    .set({ revoked_at: now })
    .where('id', '=', record.id)
    .execute();

  const tokens = await issueTokenPair(deps.db, deps.config, deps.clock, {
    userId: user.id,
    role: user.role,
  });

  return {
    ...tokens,
    user: { id: user.id, phone: user.phone, role: user.role, fullName: user.full_name },
  };
}

/** Revoking an unknown token is a no-op: logout must never leak token validity. */
export async function logout(deps: AuthDeps, refreshToken: string): Promise<void> {
  await deps.db
    .updateTable('refresh_tokens')
    .set({ revoked_at: deps.clock.now() })
    .where('token_hash', '=', hashRefreshToken(deps.config, refreshToken))
    .where('revoked_at', 'is', null)
    .execute();
}
