/**
 * The Amharic register: POLITE, everywhere (the product owner's decision).
 *
 * The informal second person is gendered (ተመለስ to a man, ተመለሺ to a
 * woman) and the apps cannot know who is reading; the polite form (ይመለሱ)
 * is gender-neutral and respectful. Both apps' bundle tests run every
 * Amharic string through this.
 *
 * A word list, not a grammar: it names the informal forms this product has
 * actually used, so they cannot come back, and flags the masculine
 * second-person suffix -ህ ("your", "you") wherever it ends a word.
 */

/** Informal imperatives and forms the bundles once used, and their kin. */
const INFORMAL_WORDS: ReadonlySet<string> = new Set([
  'ግባ',
  'ሞክር',
  'አስገባ',
  'አስወጣ',
  'ቃኝ',
  'ላክ',
  'ላክልኝ',
  'ጠይቅ',
  'ክፈት',
  'ምረጥ',
  'ቀይር',
  'ተጠቀም',
  'ዝጋ',
  'ያዝ',
  'መዝግብ',
  'ተይብ',
  'ተወው',
  'አውጣ',
  'መልስ',
  'አረጋግጥ',
  'ተመለስ',
  'ክፈል',
  'ተመለሺ',
  'አልተመደብክም',
]);

/** Words that end in -ህ without being second person: "this", "bright". */
const NOT_SECOND_PERSON: ReadonlySet<string> = new Set([
  'ይህ',
  'በዚህ',
  'ከዚህ',
  'ለዚህ',
  'የዚህ',
  'እዚህ',
  'ብሩህ',
]);

/** The informal forms in one string; empty when it is polite throughout. */
export function informalAmharic(text: string): string[] {
  const words = text
    .replace(/\{\{\w+\}\}/gu, ' ')
    .split(/[\s።፣፤፥፦፧፨!?,.;:()«»"'—–-]+/u)
    .filter((word) => word.length > 0);
  return words.filter(
    (word) => INFORMAL_WORDS.has(word) || (word.endsWith('ህ') && !NOT_SECOND_PERSON.has(word)),
  );
}
