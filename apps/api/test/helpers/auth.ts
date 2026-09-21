import type { UserRole } from '@laqum/shared';
import { signAccessToken } from '../../src/auth/tokens.js';
import type { TestContext } from './context.js';
import { createUser } from './fixtures.js';

/**
 * Mint a signed token directly instead of walking the OTP flow.
 *
 * The OTP flow has its own tests; every other suite only needs a caller with a
 * role, and going through four requests to get one would make those tests
 * about authentication rather than about what they are testing.
 */
export interface Actor {
  userId: string;
  role: UserRole;
  token: string;
  /** Ready to spread into supertest's .set(). */
  header: { Authorization: string };
}

let sequence = 0;

export async function makeActor(
  t: TestContext,
  role: UserRole = 'driver',
  phone?: string,
): Promise<Actor> {
  sequence += 1;
  const userId = await createUser(
    t.db.db,
    role,
    phone ?? `+2519119${String(sequence).padStart(5, '0')}`,
  );

  const { token } = await signAccessToken(t.ctx.config, t.ctx.clock, { userId, role });
  return { userId, role, token, header: { Authorization: `Bearer ${token}` } };
}

/**
 * Re-sign an actor's token at the clock's CURRENT time.
 *
 * Access tokens expire against the injected clock, so a test that advances
 * time past ACCESS_TOKEN_TTL_MINUTES will start getting 401s — correct
 * behaviour, and incidental proof that expiry is not reading the real clock.
 * Time-travelling tests re-issue rather than widen the TTL, which would make
 * the expiry untested.
 */
export async function reissue(t: TestContext, actor: Actor): Promise<Actor> {
  const { token } = await signAccessToken(t.ctx.config, t.ctx.clock, {
    userId: actor.userId,
    role: actor.role,
  });
  return { ...actor, token, header: { Authorization: `Bearer ${token}` } };
}

/** Assign an actor to a lot, which staff endpoints require. */
export async function staffLot(t: TestContext, actor: Actor, lotId: string): Promise<void> {
  await t.db.db.insertInto('lot_staff').values({ lot_id: lotId, user_id: actor.userId }).execute();
}
