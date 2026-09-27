import { attendantListResponseSchema, attendantResponseSchema } from '@laqum/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '../src/auth/tokens.js';
import { makeActor, staffLot, type Actor } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';
import { createLot, type LotFixture } from './helpers/fixtures.js';

/**
 * An operator admin adds and removes a lot's attendants. Who may, what is
 * refused, and that a removal takes effect at once.
 */

let t: TestContext;
let admin: Actor;
let lot: LotFixture;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  t.emitter.reset();
  lot = await createLot(t.db.db, { slots: 2 });
  admin = await makeActor(t, 'operator_admin');
  await staffLot(t, admin, lot.lotId);
});

const NEW_NUMBER = '+251911770001';

function add(actor: Actor, lotId: string, body: object) {
  return request(t.app).post(`/v1/admin/lots/${lotId}/attendants`).set(actor.header).send(body);
}

function list(actor: Actor, lotId: string) {
  return request(t.app).get(`/v1/admin/lots/${lotId}/attendants`).set(actor.header);
}

function remove(actor: Actor, lotId: string, userId: string) {
  return request(t.app).delete(`/v1/admin/lots/${lotId}/attendants/${userId}`).set(actor.header);
}

/** A staff read of the lot, as the attendant's dashboard makes it. */
async function staffCanSee(userId: string, lotId: string): Promise<number> {
  const { token } = await signAccessToken(t.ctx.config, t.ctx.clock, {
    userId,
    role: 'attendant',
  });
  const res = await request(t.app)
    .get(`/v1/staff/lots/${lotId}/slots`)
    .set('Authorization', `Bearer ${token}`);
  return res.status;
}

describe('adding an attendant', () => {
  it('makes a new number an attendant of this lot, who can then work it', async () => {
    const res = await add(admin, lot.lotId, { phone: NEW_NUMBER, fullName: 'Hanna Tesfaye' });
    expect(res.status).toBe(201);
    const { attendant } = attendantResponseSchema.parse(res.body);
    expect(attendant).toMatchObject({ phone: NEW_NUMBER, fullName: 'Hanna Tesfaye' });

    const user = await t.db.db
      .selectFrom('users')
      .select('role')
      .where('id', '=', attendant.userId)
      .executeTakeFirstOrThrow();
    expect(user.role).toBe('attendant');
    expect(await staffCanSee(attendant.userId, lot.lotId)).toBe(200);
  });

  it('is idempotent: 200 the second time, one membership', async () => {
    await add(admin, lot.lotId, { phone: NEW_NUMBER });
    const again = await add(admin, lot.lotId, { phone: NEW_NUMBER });
    expect(again.status).toBe(200);

    const listed = attendantListResponseSchema.parse((await list(admin, lot.lotId)).body);
    expect(listed.attendants.map((a) => a.phone)).toEqual([NEW_NUMBER]);
  });

  it('adds an attendant of another lot to this one as well', async () => {
    const other = await createLot(t.db.db, { slots: 1 });
    const existing = await makeActor(t, 'attendant', '+251911770002');
    await staffLot(t, existing, other.lotId);

    expect((await add(admin, lot.lotId, { phone: '+251911770002' })).status).toBe(201);
    expect(await staffCanSee(existing.userId, lot.lotId)).toBe(200);
    expect(await staffCanSee(existing.userId, other.lotId)).toBe(200);
  });

  it("REFUSES a driver's or an admin's number, and changes nothing", async () => {
    await makeActor(t, 'driver', '+251911770003');
    await makeActor(t, 'operator_admin', '+251911770004');

    for (const phone of ['+251911770003', '+251911770004']) {
      const res = await add(admin, lot.lotId, { phone });
      expect(res.status, phone).toBe(409);
      expect((res.body as { error: { code: string } }).error.code).toBe('STATE_CONFLICT');
    }
    const roles = await t.db.db
      .selectFrom('users')
      .select(['phone', 'role'])
      .where('phone', 'in', ['+251911770003', '+251911770004'])
      .orderBy('phone')
      .execute();
    expect(roles.map((r) => r.role)).toEqual(['driver', 'operator_admin']);
    const listed = attendantListResponseSchema.parse((await list(admin, lot.lotId)).body);
    expect(listed.attendants).toEqual([]);
  });

  it('rejects a malformed number', async () => {
    expect((await add(admin, lot.lotId, { phone: '0911770001' })).status).toBe(400);
  });
});

describe('removing an attendant', () => {
  it('takes effect at once: the attendant can no longer work the lot, and their sockets are told', async () => {
    const { attendant } = attendantResponseSchema.parse(
      (await add(admin, lot.lotId, { phone: NEW_NUMBER })).body,
    );
    expect(await staffCanSee(attendant.userId, lot.lotId)).toBe(200);

    expect((await remove(admin, lot.lotId, attendant.userId)).status).toBe(204);

    expect(await staffCanSee(attendant.userId, lot.lotId)).toBe(403);
    expect(t.emitter.staffRemovals).toEqual([{ lotId: lot.lotId, userId: attendant.userId }]);
    const listed = attendantListResponseSchema.parse((await list(admin, lot.lotId)).body);
    expect(listed.attendants).toEqual([]);
  });

  it('only from THIS lot', async () => {
    const other = await createLot(t.db.db, { slots: 1 });
    const both = await makeActor(t, 'attendant', '+251911770005');
    await staffLot(t, both, lot.lotId);
    await staffLot(t, both, other.lotId);

    await remove(admin, lot.lotId, both.userId);
    expect(await staffCanSee(both.userId, other.lotId)).toBe(200);
  });

  it('CANNOT remove an admin, nor someone who is not on the lot', async () => {
    const res = await remove(admin, lot.lotId, admin.userId);
    expect(res.status).toBe(404);
    const stillStaff = await t.db.db
      .selectFrom('lot_staff')
      .select('user_id')
      .where('lot_id', '=', lot.lotId)
      .where('user_id', '=', admin.userId)
      .executeTakeFirst();
    expect(stillStaff).toBeDefined();

    const stranger = await makeActor(t, 'attendant', '+251911770006');
    expect((await remove(admin, lot.lotId, stranger.userId)).status).toBe(404);
    expect(t.emitter.staffRemovals).toEqual([]);
  });
});

describe('who may', () => {
  it('ONLY an operator admin', async () => {
    const attendant = await makeActor(t, 'attendant', '+251911770007');
    await staffLot(t, attendant, lot.lotId);
    const driver = await makeActor(t, 'driver', '+251911770008');

    for (const actor of [attendant, driver]) {
      expect((await add(actor, lot.lotId, { phone: NEW_NUMBER })).status).toBe(403);
      expect((await list(actor, lot.lotId)).status).toBe(403);
      expect((await remove(actor, lot.lotId, attendant.userId)).status).toBe(403);
    }
    expect((await request(t.app).get(`/v1/admin/lots/${lot.lotId}/attendants`)).status).toBe(401);
  });

  it("NOT another operator's admin: only one who staffs this lot", async () => {
    const outsider = await makeActor(t, 'operator_admin', '+251911770009');
    const victim = await makeActor(t, 'attendant', '+251911770010');
    await staffLot(t, victim, lot.lotId);

    expect((await add(outsider, lot.lotId, { phone: NEW_NUMBER })).status).toBe(403);
    expect((await list(outsider, lot.lotId)).status).toBe(403);
    expect((await remove(outsider, lot.lotId, victim.userId)).status).toBe(403);
    expect(await staffCanSee(victim.userId, lot.lotId)).toBe(200);
  });
});
