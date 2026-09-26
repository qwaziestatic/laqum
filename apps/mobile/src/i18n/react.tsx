import { formatClock, formatSantim, type Locale } from '@laqum/shared';
import * as SecureStore from 'expo-secure-store';
import i18next from 'i18next';
import { useMemo } from 'react';
import { initReactI18next, useTranslation } from 'react-i18next';
import { I18nManager } from 'react-native';
import {
  I18N_OPTIONS,
  type MessageKey,
  type Params,
  type Phrase,
  type Shown,
  isLocale,
  languageForLocale,
  verbatim,
} from './core.js';

/**
 * The app's i18next instance, and the hook screens translate with.
 *
 * LANGUAGE: the driver's own choice if they made one, otherwise the phone's.
 * The phone's locale comes from React Native's I18nManager (Android reports
 * it from the device configuration), falling back to Hermes' Intl. Neither
 * is a new native module, so this needs no new build.
 */

const LANGUAGE_KEY = 'laqum.language';

export function deviceLocale(): string | null {
  try {
    const fromDevice = I18nManager.getConstants().localeIdentifier;
    if (fromDevice) return fromDevice;
  } catch {
    // Not available: fall through to Intl.
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return null;
  }
}

// Synchronous (initAsync: false), so the first frame is already translated.
void i18next.use(initReactI18next).init({
  ...I18N_OPTIONS,
  lng: languageForLocale(deviceLocale()),
});

/**
 * Apply a stored choice, if there is one. Once per start: every caller gets
 * the same promise, so the opening animation can wait for the driver's
 * language before it announces anything, without reading storage twice.
 */
let restoring: Promise<void> | null = null;
export function restoreLanguage(): Promise<void> {
  restoring ??= (async () => {
    try {
      const stored = await SecureStore.getItemAsync(LANGUAGE_KEY);
      if (isLocale(stored) && stored !== i18next.language) await i18next.changeLanguage(stored);
    } catch {
      // Unreadable storage: the phone's language stands.
    }
  })();
  return restoring;
}

/** Switch now, and remember it over the phone's language from here on. */
export async function chooseLanguage(locale: Locale): Promise<void> {
  await i18next.changeLanguage(locale);
  try {
    await SecureStore.setItemAsync(LANGUAGE_KEY, locale);
  } catch {
    // Not remembered, but switched: the next start follows the phone again.
  }
}

export interface Translate {
  (key: MessageKey, params?: Params): Shown;
  /** A phrase from a pure module (view.ts, messages.ts, …). */
  phrase: (item: Phrase) => Shown;
  /** An amount in birr: "20.00 ብር" / "20.00 ETB". */
  money: (santim: number) => Shown;
  /**
   * A clock time in Addis Ababa: "ከሰዓት 8:05" (the Ethiopian clock) or
   * "14:05". Never for durations or countdowns (shared clockDisplay.ts).
   */
  clock: (instant: Date, options?: { seconds?: boolean }) => Shown;
  language: Locale;
}

/** Re-renders on a language change, like useTranslation. */
export function useT(): Translate {
  const { t, i18n } = useTranslation();
  const language = isLocale(i18n.language) ? i18n.language : languageForLocale(i18n.language);

  return useMemo(() => {
    const translate = (key: MessageKey, params?: Params): Shown => verbatim(t(key, params ?? {}));
    return Object.assign(translate, {
      phrase: (item: Phrase) => translate(item.key, item.params),
      money: (santim: number) => translate('money.birr', { amount: formatSantim(santim) }),
      clock: (instant: Date, options?: { seconds?: boolean }) =>
        verbatim(formatClock(instant, language, options)),
      language,
    });
  }, [t, language]);
}
