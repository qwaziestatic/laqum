import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * OTP generation and hashing.
 *
 * A six-digit code has only a million possibilities, so the stored hash must be
 * slow: a fast digest would be trivially reversible from a database dump.
 * scrypt comes from node:crypto, so there is no native module to build.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
export const OTP_DIGITS = 6;

/** Six digits, uniformly distributed, zero-padded. */
export function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
}

/** Stored as `saltHex:keyHex`; the salt travels with the hash. */
export async function hashOtp(code: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(code, salt, KEY_BYTES);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

/** Constant-time. Never short-circuits on a mismatched prefix. */
export async function verifyOtp(code: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':');
  if (saltHex === undefined || keyHex === undefined) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(keyHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEY_BYTES) return false;

  const actual = await scryptAsync(code, Buffer.from(saltHex, 'hex'), KEY_BYTES);
  return timingSafeEqual(actual, expected);
}
