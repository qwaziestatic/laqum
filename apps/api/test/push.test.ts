import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeActor, type Actor } from './helpers/auth.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { migrateFresh, truncateAll } from './helpers/db.js';

/**
 * Phase 4 stores the token; Phase 5 sends to it. These tests cover the
 * storing, including the case that is a privacy bug rather than a constraint
 * violation: a token moving between users.
 */

let t: TestContext;
let driver: Actor;

beforeAll(async () => {
  await migrateFresh();
  t = await createTestContext();
}, 60_000);

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db.db);
  driver = await makeActor(t, 'driver');
});

const TOKEN = 'ExponentPushToken[abcdEFGH1234_-]';

describe('POST /v1/push/tokens', () => {
  it('stores a token for the signed-in driver', async () => {
    const res = await request(t.app)
      .post('/v1/push/tokens')
      .set(driver.header)
      .send({ expoPushToken: TOKEN });

    expect(res.status).toBe(204);

    const row = await t.db.db
      .selectFrom('push_tokens')
      .selectAll()
      .where('expo_push_token', '=', TOKEN)
      .executeTakeFirstOrThrow();
    expect(row.user_id).toBe(driver.userId);
  });

  it('is idempotent: registering twice leaves ONE row', async () => {
    // The app re-registers on every launch, because Expo tokens rotate.
    for (let i = 0; i < 3; i++) {
      await request(t.app).post('/v1/push/tokens').set(driver.header).send({
        expoPushToken: TOKEN,
      });
    }

    const rows = await t.db.db
      .selectFrom('push_tokens')
      .selectAll()
      .where('expo_push_token', '=', TOKEN)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('RE-POINTS a token that moves to another user', async () => {
    /*
     * A phone is shared, resold, or a driver signs into a second account. The
     * token is unique, so the naive insert would 409 — and the PREVIOUS owner
     * would keep receiving this driver's booking notifications. That is a
     * privacy leak, so the row moves.
     */
    await request(t.app).post('/v1/push/tokens').set(driver.header).send({
      expoPushToken: TOKEN,
    });

    const second = await makeActor(t, 'driver');
    const res = await request(t.app)
      .post('/v1/push/tokens')
      .set(second.header)
      .send({ expoPushToken: TOKEN });

    expect(res.status).toBe(204);

    const rows = await t.db.db
      .selectFrom('push_tokens')
      .selectAll()
      .where('expo_push_token', '=', TOKEN)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id, 'the token follows the phone, not the account').toBe(second.userId);
  });

  it('rejects a malformed token', async () => {
    for (const bad of ['', 'not-a-token', 'ExponentPushToken[]', '<script>']) {
      const res = await request(t.app)
        .post('/v1/push/tokens')
        .set(driver.header)
        .send({ expoPushToken: bad });
      expect(res.status, bad).toBe(400);
    }
  });

  it('accepts both Expo token spellings', async () => {
    // Expo has emitted both ExponentPushToken[...] and ExpoPushToken[...].
    for (const token of ['ExponentPushToken[aaaa]', 'ExpoPushToken[bbbb]']) {
      const res = await request(t.app)
        .post('/v1/push/tokens')
        .set(driver.header)
        .send({ expoPushToken: token });
      expect(res.status, token).toBe(204);
    }
  });

  it('requires authentication', async () => {
    const res = await request(t.app).post('/v1/push/tokens').send({ expoPushToken: TOKEN });
    expect(res.status).toBe(401);
  });
});
