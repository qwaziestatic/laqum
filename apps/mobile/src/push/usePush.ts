import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import type { Api } from '../api/endpoints.js';
import type { Locale } from '@laqum/shared';
import { pushDeps } from './expoDeps.js';
import { maybeRegisterForPush } from './registration.js';
import { bookingIdFromNotification } from './tap.js';

/*
 * Shown while the app is open too: a hold about to be released matters on
 * any screen. Sound on, because on Android a notification without it is not
 * shown as a banner at all (expo-notifications' NotificationBehavior docs).
 */
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
});

/**
 * Push, for the signed-in driver, from the root layout.
 *
 * - The token is registered again whenever the driver signs in or the
 *   language on screen changes, so notifications arrive in it (D3). Never a
 *   prompt: `hasBooked` is false, so an undecided permission stays undecided
 *   and the ask keeps its moment (registration.ts). Only a permission already
 *   granted uploads.
 * - A tapped notification opens its booking, including the tap that started
 *   the app. Not before the session is known, and not when signed out.
 */
export function usePush(api: Api, userId: string | undefined, language: Locale): void {
  useEffect(() => {
    if (!userId) return;
    void maybeRegisterForPush(pushDeps(api, false));
  }, [api, userId, language]);

  useEffect(() => {
    if (!userId) return;
    const open = (response: Notifications.NotificationResponse | null): void => {
      if (response?.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      Notifications.clearLastNotificationResponse();
      const id = bookingIdFromNotification(response.notification.request.content.data);
      if (id) router.push({ pathname: '/booking/[id]', params: { id } });
    };
    open(Notifications.getLastNotificationResponse());
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => {
      subscription.remove();
    };
  }, [userId]);
}
