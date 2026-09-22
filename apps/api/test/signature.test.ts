import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_HEADER,
  WEAK_SIGNATURE_HEADER,
  signPayload,
  verifyWebhookSignature,
} from '../src/payments/signature.js';

const SECRET = 'CHASECK_TEST-0123456789abcdef0123456789abcdef';
const BODY = Buffer.from('{"tx_ref":"laqum-dep-abc","status":"success","amount":"20.00"}');

describe('verifyWebhookSignature', () => {
  it('accepts a signature over the exact raw bytes', () => {
    expect(verifyWebhookSignature(SECRET, BODY, signPayload(SECRET, BODY))).toEqual({ ok: true });
  });

  it('accepts an upper-case hex signature', () => {
    const upper = signPayload(SECRET, BODY).toUpperCase();
    expect(verifyWebhookSignature(SECRET, BODY, upper).ok).toBe(true);
  });

  it('tolerates surrounding whitespace from a header parser', () => {
    expect(verifyWebhookSignature(SECRET, BODY, `  ${signPayload(SECRET, BODY)}  `).ok).toBe(true);
  });

  it('rejects a body altered by a single byte', () => {
    const signature = signPayload(SECRET, BODY);
    const tampered = Buffer.from('{"tx_ref":"laqum-dep-abc","status":"success","amount":"90.00"}');
    expect(verifyWebhookSignature(SECRET, tampered, signature)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a signature made with a different secret', () => {
    const forged = signPayload('CHASECK_TEST-someone-elses-secret-key-here-0000', BODY);
    expect(verifyWebhookSignature(SECRET, BODY, forged)).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a missing or empty signature', () => {
    expect(verifyWebhookSignature(SECRET, BODY, undefined)).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
    expect(verifyWebhookSignature(SECRET, BODY, '   ')).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it('rejects a malformed signature instead of throwing', () => {
    // timingSafeEqual throws on a length mismatch, and that throw would itself
    // leak length information, so the shape is checked first.
    for (const bad of ['not-hex', 'abc123', 'a'.repeat(63), 'a'.repeat(65), 'zz'.repeat(32)]) {
      expect(verifyWebhookSignature(SECRET, BODY, bad), bad).toEqual({
        ok: false,
        reason: 'malformed_signature',
      });
    }
  });

  it('is byte-exact: a re-serialised body does not verify', () => {
    // Chapa's own v1 example hashes JSON.stringify(req.body). Re-serialising
    // changes whitespace, so the digest changes. This is why the raw bytes are
    // captured and why express.json must not touch this route first.
    const signature = signPayload(SECRET, BODY);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(BODY.toString()), null, 2));

    expect(reserialised.toString()).not.toBe(BODY.toString());
    expect(verifyWebhookSignature(SECRET, reserialised, signature).ok).toBe(false);
  });
});

describe('the weak chapa-signature header', () => {
  it('is a constant, which is exactly why it is not accepted', () => {
    // Chapa documents chapa-signature as an HMAC of the secret keyed by the
    // secret. It does not involve the body at all, so it is identical for
    // every request and proves nothing about what was sent.
    const forBodyA = createHmac('sha256', SECRET).update(SECRET).digest('hex');
    const forBodyB = createHmac('sha256', SECRET).update(SECRET).digest('hex');

    expect(forBodyA).toBe(forBodyB);

    // And it does not verify as a payload signature, so a caller presenting
    // only that header is refused.
    expect(verifyWebhookSignature(SECRET, BODY, forBodyA).ok).toBe(false);
  });

  it('names both headers, so the rejection reason is greppable', () => {
    expect(SIGNATURE_HEADER).toBe('x-chapa-signature');
    expect(WEAK_SIGNATURE_HEADER).toBe('chapa-signature');
  });
});
