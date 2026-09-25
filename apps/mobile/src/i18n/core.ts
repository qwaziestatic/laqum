import { DEFAULT_LOCALE, LOCALES, type Locale } from '@laqum/shared';
import { createInstance, type i18n as I18n } from 'i18next';
import { am } from './am.js';
import { en } from './en.js';

/**
 * The driver app's translations, without React or React Native.
 *
 * Pure modules (booking/view.ts, api/messages.ts, …) return a PHRASE, a key
 * plus its values, never a string: they stay testable without a renderer,
 * and the API's contract tests can import them. Screens turn phrases into
 * text with useT() (i18n/react.tsx).
 */

/** The bundle's shape with every leaf widened to string: what am.ts must match. */
export type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };
export type Messages = Shape<typeof en>;

/** Every dotted path to a leaf, e.g. 'booking.payDeposit'. */
type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<typeof en>;

export type Params = Readonly<Record<string, string | number>>;

export interface Phrase {
  key: MessageKey;
  params?: Params;
}

export function phrase(key: MessageKey, params?: Params): Phrase {
  return params ? { key, params } : { key };
}

declare const shown: unique symbol;
/**
 * Text that may appear on screen: translated, or data shown as it is.
 *
 * The UI primitives (src/ui.tsx) accept only this for labels, messages and
 * text, so an English literal written into a screen does not compile. The
 * only other way in is verbatim(), for data: a lot's name, a plate, a
 * number. i18n.test.ts checks verbatim() is never handed wording.
 */
export type Shown = string & { readonly [shown]: true };

export function verbatim(value: string): Shown {
  return value as Shown;
}

export const resources = {
  am: { translation: am },
  en: { translation: en },
} as const satisfies Record<Locale, { translation: Messages }>;

/**
 * The app's language for a device locale such as `am_ET` or `en-US`.
 *
 * Amharic for an Amharic phone, English for an English one, and otherwise
 * the product's default, Amharic, as the dashboard does.
 */
export function languageForLocale(locale: string | null | undefined): Locale {
  const language = (locale ?? '').split(/[-_]/u)[0]?.toLowerCase();
  const match = LOCALES.find((candidate) => candidate === language);
  return match ?? DEFAULT_LOCALE;
}

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

export const I18N_OPTIONS = {
  resources,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: [...LOCALES],
  // Synchronous: the bundles are in the JS, so there is nothing to wait for,
  // and the first frame is already in the right language.
  initAsync: false,
  // React escapes rendered values; nothing here is HTML.
  interpolation: { escapeValue: false },
  returnNull: false,
} as const;

/**
 * A standalone translator, for tests and for the API's contract tests: what
 * a phrase reads as in one language, without the app's singleton.
 */
export function translator(locale: Locale): (item: Phrase) => string {
  const instance: I18n = createInstance();
  void instance.init({ ...I18N_OPTIONS, lng: locale });
  return (item) => instance.t(item.key, item.params ?? {});
}
