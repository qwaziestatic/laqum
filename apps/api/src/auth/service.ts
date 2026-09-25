import type { Database } from '@laqum/db';
import {
  AppError,
  type Clock,
  type OtpAudience,
  type UserRole,
  addMinutes,
  isStaffRole,
} from '@laqum/shared';
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
  input: { phone: string; ip: string; audience?: OtpAudience | undefined },
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
  // Hashed for EVERY request, including a staff-mode request that sends
  // nothing: scrypt is deliberately slow, and skipping it would make those
  // answers measurably faster, i.e. tell a staff number from any other.
  const codeHash = await hashOtp(code);

  if (input.audience === 'staff' && !isStaffUser(await findUser(deps, input.phone))) {
    // No code, no SMS, no account — and the same answer a staff number gets.
    // Not logged with the phone: that would be a list of probed numbers.
    deps.logger.info('staff OTP requested for a number that is not staff: nothing sent');
    return { expiresAt };
  }

  await deps.db
    .insertInto('otp_codes')
    .values({
      phone: input.phone,
      code_hash: codeHash,
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
 * Verify an OTP and start a session. See OTP_AUDIENCES for the two audiences.
 */
export async function verifyOtpAndSignIn(
  deps: AuthDeps,
  input: { phone: string; code: string; audience?: OtpAudience | undefined },
): Promise<Session> {
  if (input.audience === 'staff') return verifyStaffAndSignIn(deps, input);

  await consumeCode(deps, input);
  return signIn(deps, await findOrCreateUser(deps, input.phone));
}

/**
 * The dashboard's sign-in: staff accounts only, and nothing learnable.
 *
 * A number that is not staff gets no session and no account, and EVERY
 * failure, staff or not, is one answer with no details. Otherwise a wrong
 * code would say "not correct, 4 attempts left" for a staff number and "no
 * code was requested" for anyone else, which is exactly the directory of
 * staff numbers this mode exists to withhold.
 */
async function verifyStaffAndSignIn(
  deps: AuthDeps,
  input: { phone: string; code: string },
): Promise<Session> {
  const user = await findUser(deps, input.phone);
  if (!isStaffUser(user)) {
    // The same scrypt work a real comparison costs, so the refusal is not
    // measurably faster. The number's own codes (a driver's, from the app)
    // are not touched: no attempt is burned on them.
    await verifyOtp(input.code, await dummyHash());
    throw staffSignInFailed();
  }
  try {
    await consumeCode(deps, input);
  } catch (err) {
    if (err instanceof AppError && err.code.startsWith('OTP_')) throw staffSignInFailed();
    throw err;
  }
  return signIn(deps, user);
}

function staffSignInFailed(): AppError {
  return new AppError('OTP_INVALID', 'That code is not correct or has expired. Request a new one.');
}

let dummyHashPromise: Promise<string> | null = null;

/** A hash to compare against when there is no real code: see verifyStaffAndSignIn. */
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashOtp('000000');
  return dummyHashPromise;
}

/**
 * Check a code and consume it, or throw the reason it cannot be used.
 *
 * Only the most recent unconsumed code for the phone is considered: requesting
 * a new code must invalidate the previous one, or a leaked older code stays
 * usable for its whole five minutes.
 */
async function consumeCode(deps: AuthDeps, input: { phone: string; code: string }): Promise<void> {
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
}

async function signIn(deps: AuthDeps, user: SessionUser): Promise<Session> {
  // A successful sign-in should not leave the caller rate limited.
  await deps.rateLimiter.reset(
    `otp:phone:${user.phone}`,
    deps.config.OTP_RATE_LIMIT_WINDOW_MINUTES,
  );

  const tokens = await issueTokenPair(deps.db, deps.config, deps.clock, {
    userId: user.id,
    role: user.role,
  });

  return { ...tokens, user };
}

async function findUser(deps: AuthDeps, phone: string): Promise<SessionUser | null> {
  const row = await deps.db
    .selectFrom('users')
    .select(['id', 'phone', 'role', 'full_name'])
    .where('phone', '=', phone)
    .executeTakeFirst();
  return row ? { id: row.id, phone: row.phone, role: row.role, fullName: row.full_name } : null;
}

function isStaffUser(user: SessionUser | null): user is SessionUser {
  return user !== null && isStaffRole(user.role);
}

/** First sign-in creates the account. Staff roles are assigned by an admin. */
async function findOrCreateUser(deps: AuthDeps, phone: string): Promise<SessionUser> {
  const existing = await findUser(deps, phone);
  if (existing) return existing;

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

/**
 * Sign in a seeded user by phone, with no OTP.
 *
 * Reachable ONLY when config.DEV_AUTH_ENABLED — the route is not registered
 * otherwise (see auth/routes.ts). Two deliberate differences from the real
 * sign-in, both there to make this useless as a back door if it ever were
 * reachable in error:
 *
 *   - it will NOT create an account. The real flow creates a driver on first
 *     sign-in; this one refuses an unknown number, so it can only ever return
 *     a user the seed already put there.
 *   - it re-reads the role from the database rather than accepting one, so it
 *     cannot be used to mint an attendant token for a driver's number.
 */
export async function devSignIn(deps: AuthDeps, phone: string): Promise<Session> {
  if (!deps.config.DEV_AUTH_ENABLED) {
    // Defence in depth: the route should not exist, but a direct call from a
    // future code path must not bypass the gate either.
    throw new AppError('FORBIDDEN', 'Dev login is disabled');
  }

  const user = await deps.db
    .selectFrom('users')
    .select(['id', 'phone', 'role', 'full_name'])
    .where('phone', '=', phone)
    .executeTakeFirst();

  if (!user) {
    throw new AppError('NOT_FOUND', 'No seeded user with that phone number');
  }

  deps.logger.warn({ phone, role: user.role }, 'DEV LOGIN: signed in without an OTP');

  const tokens = await issueTokenPair(deps.db, deps.config, deps.clock, {
    userId: user.id,
    role: user.role,
  });

  return {
    ...tokens,
    user: { id: user.id, phone: user.phone, role: user.role, fullName: user.full_name },
  };
}
