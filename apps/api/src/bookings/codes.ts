import { randomBytes, randomInt } from 'node:crypto';
import { SHORT_CODE_ALPHABET, SHORT_CODE_LENGTH } from '@laqum/shared';

/**
 * Server-only. This lives here rather than in @laqum/shared because it needs
 * node:crypto, and @laqum/shared is bundled into the browser dashboard.
 * The alphabet, length and pattern stay in shared, so validation is shared
 * while generation is not.
 */

/**
 * The manual fallback an attendant reads aloud when a QR scan fails.
 *
 * randomInt is rejection-sampled and therefore unbiased; taking bytes modulo
 * 32 would be fine for this alphabet but would silently become biased if the
 * alphabet ever changed length.
 */
export function generateShortCode(): string {
  let code = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    // charAt, not [], so the result is a string rather than string | undefined.
    code += SHORT_CODE_ALPHABET.charAt(randomInt(SHORT_CODE_ALPHABET.length));
  }
  return code;
}

/**
 * The QR payload. 256 bits, url-safe, and globally unique rather than unique
 * only among live bookings: it is a bearer credential for check-in, so it must
 * never be guessable or reused.
 */
export function generateQrToken(): string {
  return randomBytes(32).toString('base64url');
}
