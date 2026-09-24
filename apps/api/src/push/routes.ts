import { registerPushTokenSchema } from '@laqum/shared';
import { Router } from 'express';
import type { AppContext } from '../context.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { handle, validateBody } from '../middleware/validate.js';

/**
 * Push token registration.
 *
 * PHASE 4 STORES THE TOKEN; PHASE 5 SENDS TO IT. The brief puts "push
 * notifications end to end" in Phase 5, so there is deliberately no sending
 * here — this exists so that when Phase 5 arrives there is already a populated
 * push_tokens table rather than an empty one and a migration of behaviour.
 */

/*
 * The token format is validated rather than accepted as free text: this
 * column is unique and will later be fed to Expo's push service. The schema
 * is SHARED (registerPushTokenSchema) so the app builds its request from the
 * same definition that validates it here.
 */

export function pushRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.post(
    '/tokens',
    validateBody(registerPushTokenSchema),
    handle(async (req, res) => {
      const user = currentUser(res);
      const { expoPushToken } = req.body as { expoPushToken: string };

      /*
       * The token is UNIQUE across users, and it genuinely can move between
       * them: a shared or resold phone, or a driver signing in to a second
       * account. So the conflict re-points the row at the current user rather
       * than failing — otherwise the previous owner would keep receiving this
       * driver's booking notifications, which is a privacy leak, not a
       * constraint violation.
       */
      await ctx.db
        .insertInto('push_tokens')
        .values({
          user_id: user.userId,
          expo_push_token: expoPushToken,
          created_at: ctx.clock.now(),
        })
        .onConflict((oc) =>
          oc.column('expo_push_token').doUpdateSet({
            user_id: user.userId,
            created_at: ctx.clock.now(),
          }),
        )
        .execute();

      // 204: the client has nothing to do with a body here, and the token is
      // already known to it.
      res.status(204).end();
    }),
  );

  return router;
}
