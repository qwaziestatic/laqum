import { DEFAULT_LOCALE, LOCALES, type Locale } from '@laqum/shared';
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import am from './locales/am.json';
import en from './locales/en.json';

/**
 * Amharic and English from day one, per the brief. No user-facing string is
 * hard-coded in a component: every one comes from these bundles.
 *
 * Amharic is the default. The detector still honours a stored choice or the
 * browser's language, so an English-preferring device is not forced into
 * Amharic.
 */
export const resources = {
  am: { translation: am },
  en: { translation: en },
} as const;

export type TranslationKeys = typeof en;

export async function initI18n(locale?: Locale): Promise<typeof i18n> {
  await i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: [...LOCALES],
      ...(locale ? { lng: locale } : {}),
      interpolation: {
        // React already escapes rendered values.
        escapeValue: false,
      },
    });
  return i18n;
}

export default i18n;
