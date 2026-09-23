import * as SecureStore from 'expo-secure-store';
import type { Session, TokenStore } from './client.js';

/**
 * Tokens in the platform keystore — Keychain on iOS, Keystore-backed
 * EncryptedSharedPreferences on Android.
 *
 * NOT AsyncStorage: that is a plaintext file inside the app sandbox, readable
 * on a rooted device or by anything that gets a backup. A refresh token is a
 * month-long credential for a payment-capable account.
 *
 * `requireAuthentication` is deliberately NOT set. It would demand a biometric
 * prompt on every read, including at launch — for a parking app that is a
 * barrier out of proportion to the risk, and a driver standing in the rain
 * would abandon it.
 */

const KEY = 'laqum.session';

export const secureTokenStore: TokenStore = {
  async read() {
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      if (!raw) return null;
      return JSON.parse(raw) as Session;
    } catch {
      /*
       * A read failure is treated as "no session", not as a crash.
       *
       * It happens for real: the keystore is wiped when the device's lock
       * screen credential changes, and the stored blob can outlive a schema
       * change. Either way the right answer is to sign in again, not to fail
       * to launch.
       */
      return null;
    }
  },

  async write(session) {
    if (session === null) {
      await SecureStore.deleteItemAsync(KEY).catch(() => undefined);
      return;
    }
    await SecureStore.setItemAsync(KEY, JSON.stringify(session), {
      // Available after first unlock, so a scheduled refresh can run without
      // the driver having the phone open. Not `Always`, which survives even a
      // locked device and is weaker than we need.
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  },
};
