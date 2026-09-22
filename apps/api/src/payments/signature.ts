import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Chapa webhook signature verification.
 *
 * Chapa documents TWO headers
 * (https://developer.chapa.co/integrations/webhooks):
 *
 *   chapa-signature    "a HMAC SHA256 signature of your secret key signed
 *                       using your secret key"
 *   x-chapa-signature  "a HMAC SHA256 signature of the event payload signed
 *                       using your secret key"
 *
 * and says "If both headers are present but one of the headers is valid, it is
 * sufficient to proceed."
 *
 * WE DELIBERATELY DO NOT DO THAT. `chapa-signature` hashes the secret with
 * itself, so it is a CONSTANT: it is identical on every request and proves
 * nothing whatsoever about the body. Accepting it would let anyone who ever
 * observed one valid webhook replay any payload they liked at us. Only
 * `x-chapa-signature`, which is bound to the payload, is accepted.
 *
 * The signature is computed over the RAW request bytes. Chapa's own v1 example
 * re-serialises with JSON.stringify(req.body), which is fragile — key order,
 * whitespace and unicode escaping all have to match byte for byte. Chapa's v2
 * documentation says to use "the exact JSON bytes sent in the request, not
 * reconstructed or reserialized", which is what this does.
 */

export const SIGNATURE_HEADER = 'x-chapa-signature';
/** Recognised so it can be explicitly REJECTED with a clear reason. */
export const WEAK_SIGNATURE_HEADER = 'chapa-signature';

export type SignatureFailure = 'missing_signature' | 'malformed_signature' | 'signature_mismatch';

export type SignatureCheck = { ok: true } | { ok: false; reason: SignatureFailure };

const HEX_64 = /^[a-f0-9]{64}$/iu;

export function signPayload(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signature: string | undefined,
): SignatureCheck {
  if (signature === undefined || signature.trim().length === 0) {
    return { ok: false, reason: 'missing_signature' };
  }

  const candidate = signature.trim();
  // Checked before the compare: timingSafeEqual throws on a length mismatch,
  // and that throw would itself leak length information.
  if (!HEX_64.test(candidate)) {
    return { ok: false, reason: 'malformed_signature' };
  }

  const expected = Buffer.from(signPayload(secret, rawBody), 'hex');
  const actual = Buffer.from(candidate.toLowerCase(), 'hex');

  if (expected.length !== actual.length) {
    return { ok: false, reason: 'malformed_signature' };
  }
  return timingSafeEqual(expected, actual)
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' };
}
