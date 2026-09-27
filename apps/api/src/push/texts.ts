import { type Locale, formatClock, formatSantim } from '@laqum/shared';

/**
 * WHAT THE DRIVER READS ON THE LOCK SCREEN, in the language stored with the
 * device's token (migration 006; the app registers again when it changes).
 *
 * Polite register throughout, like both apps. Clock times go through
 * formatClock: the Ethiopian clock on an Amharic phone. Amounts are written
 * as the app writes them. Listed in docs/AMHARIC-REVIEW.md; key parity and
 * the register are tested.
 *
 * Only what the driver needs, and nothing that identifies them: no plate,
 * no phone number (the text crosses the border through Expo and Google).
 */

export const NOTIFICATION_KINDS = [
  'hold-reminder',
  'hold-expired',
  'time-reminder',
  'overstay',
  'amount-due',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

interface Template {
  title: string;
  body: string;
}

export const PUSH_TEXTS = {
  am: {
    'hold-reminder': {
      title: 'ቦታዎ ሊለቀቅ {{minutes}} ደቂቃ ቀርቷል',
      body: 'በ{{lot}} ያስያዙት ቦታ እስከ {{time}} ድረስ ተይዟል። ከዚያ በኋላ ለሌላ ሰው ይለቀቃል።',
    },
    'hold-expired': {
      title: 'ያስያዙት ቦታ ተለቋል',
      body: 'በ{{lot}} ያስያዙት ቦታ {{time}} ላይ ተለቋል። አሁንም ቦታ ካስፈለገዎት እንደገና ያስይዙ።',
    },
    'time-reminder': {
      title: 'የማቆሚያ ጊዜዎ ሊያበቃ {{minutes}} ደቂቃ ቀርቷል',
      body: 'በ{{lot}} የማቆሚያ ጊዜዎ {{time}} ላይ ያበቃል። ተጨማሪ ጊዜ ከፈለጉ በመተግበሪያው ያራዝሙ።',
    },
    overstay: {
      title: 'ጊዜ አልፏል',
      body: 'በ{{lot}} ከአሁን በኋላ ያለው ጊዜ በከፍተኛ ዋጋ ይከፈላል።',
    },
    'amount-due': {
      title: 'የሚከፈል፦ {{amount}} ብር',
      body: 'በ{{lot}} ማቆሚያዎ አብቅቷል። በመተግበሪያው ወይም ለማቆሚያው ሠራተኛ በጥሬ ገንዘብ ይክፈሉ።',
    },
  },
  en: {
    'hold-reminder': {
      title: 'Your slot is released in {{minutes}} min',
      body: 'Your slot at {{lot}} is held until {{time}}. After that it is released to someone else.',
    },
    'hold-expired': {
      title: 'Your slot has been released',
      body: 'Your slot at {{lot}} was released at {{time}}. Book again if you still need one.',
    },
    'time-reminder': {
      title: 'Your parking ends in {{minutes}} min',
      body: 'Your parking at {{lot}} ends at {{time}}. Extend it in the app if you need more time.',
    },
    overstay: {
      title: 'Your time is up',
      body: 'Parking at {{lot}} is now charged at the overstay rate.',
    },
    'amount-due': {
      title: 'Payment due: {{amount}} ETB',
      body: 'Your parking at {{lot}} has ended. Pay in the app, or in cash to the attendant.',
    },
  },
} as const satisfies Record<Locale, Record<NotificationKind, Template>>;

export interface TextValues {
  lot: string;
  /** Formatted in the device's language (the Ethiopian clock in Amharic). */
  time?: Date;
  minutes?: number;
  amountSantim?: number;
}

export function pushText(
  kind: NotificationKind,
  locale: Locale,
  values: TextValues,
): { title: string; body: string } {
  const template = PUSH_TEXTS[locale][kind];
  const vars: Record<string, string> = {
    lot: values.lot,
    time: values.time ? formatClock(values.time, locale) : '',
    minutes: values.minutes === undefined ? '' : String(values.minutes),
    amount: values.amountSantim === undefined ? '' : formatSantim(values.amountSantim),
  };
  const fill = (text: string): string =>
    text.replace(/\{\{(\w+)\}\}/gu, (_, name: string) => vars[name] ?? '');
  return { title: fill(template.title), body: fill(template.body) };
}
