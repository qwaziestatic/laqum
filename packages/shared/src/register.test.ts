import { describe, expect, it } from 'vitest';
import { informalAmharic } from './register.js';

describe('informalAmharic', () => {
  it('flags the informal forms the dashboard used before the decision', () => {
    expect(informalAmharic('ቃኝ')).toEqual(['ቃኝ']);
    expect(informalAmharic('መጀመሪያ መኪናውን አስወጣ')).toEqual(['አስወጣ']);
    expect(informalAmharic('ክፍለ ጊዜህ አብቅቷል። እንደገና ግባ።')).toEqual(['ጊዜህ', 'ግባ']);
    expect(informalAmharic('ጥቂት ደቂቃዎች ቆይተህ እንደገና ሞክር።')).toEqual(['ቆይተህ', 'ሞክር']);
    expect(informalAmharic('በዚህ ማቆሚያ ላይ አልተመደብክም')).toEqual(['አልተመደብክም']);
  });

  it('passes their polite replacements', () => {
    for (const polite of [
      'ይቃኙ',
      'መጀመሪያ መኪናውን ያስወጡ',
      'ክፍለ ጊዜዎ አብቅቷል። እንደገና ይግቡ።',
      'ጥቂት ደቂቃዎች ቆይተው እንደገና ይሞክሩ።',
      'በዚህ ማቆሚያ ላይ አልተመደቡም',
    ]) {
      expect(informalAmharic(polite), polite).toEqual([]);
    }
  });

  it('does not mistake "this" or "bright" for "your"', () => {
    expect(informalAmharic('ይህ ገጽ ያልተዘመነ ሊሆን ይችላል')).toEqual([]);
    expect(informalAmharic('ብሩህ')).toEqual([]);
  });

  it('ignores {{placeholders}}', () => {
    expect(informalAmharic('{{action}} አልተቻለም')).toEqual([]);
  });
});
