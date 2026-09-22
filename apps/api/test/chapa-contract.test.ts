import { describe, expect, it } from 'vitest';
import { ChapaProvider } from '../src/payments/chapa.js';
import { isProviderUnavailable } from '../src/payments/provider.js';
import { testLogger } from './helpers/db.js';

/**
 * What ChapaProvider actually puts on the wire — asserted against an injected
 * fetch, with no network.
 *
 * Every expectation below traces to Chapa's published documentation:
 *   POST /v1/transaction/initialize      developer.chapa.co/integrations/accept-payments
 *   GET  /v1/transaction/verify/<tx_ref> developer.chapa.co/integrations/verify-payments
 *   POST /v1/refund/<tx_ref>             developer.chapa.co/refund
 *
 * The sandbox script is what proves the real service agrees; this proves we
 * send what the docs describe.
 */

const SECRET = 'CHASECK_TEST-0123456789abcdef';
const BASE = 'https://api.chapa.co';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function providerWith(responder: (url: string) => { status: number; json: unknown }): {
  provider: ChapaProvider;
  calls: Captured[];
} {
  const calls: Captured[] = [];

  // Narrower than fetch's real signature on purpose: this stub is only ever
  // called with a string URL, and typing it as RequestInfo would make String()
  // able to produce "[object Object]".
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({
      url: href,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });

    const { status, json } = responder(href);
    return Promise.resolve(
      new Response(JSON.stringify(json), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;

  return {
    provider: new ChapaProvider({
      secretKey: SECRET,
      baseUrl: BASE,
      logger: testLogger(),
      fetchImpl,
    }),
    calls,
  };
}

describe('initialize', () => {
  it('POSTs the documented fields to the documented URL', async () => {
    const { provider, calls } = providerWith(() => ({
      status: 200,
      json: {
        status: 'success',
        message: 'Hosted Link',
        data: { checkout_url: 'https://checkout.chapa.co/checkout/payment/abc' },
      },
    }));

    const result = await provider.initialize({
      txRef: 'laqum-dep-abc123',
      amountSantim: 2000,
      callbackUrl: 'https://laqum.example/v1/webhooks/chapa',
      returnUrl: 'https://laqum.example/payment-complete',
      email: 'driver@example.com',
      firstName: 'Abebe',
    });

    expect(result.checkoutUrl).toBe('https://checkout.chapa.co/checkout/payment/abc');

    const call = calls[0];
    expect(call?.url).toBe('https://api.chapa.co/v1/transaction/initialize');
    expect(call?.method).toBe('POST');
    expect(call?.headers['Authorization']).toBe(`Bearer ${SECRET}`);

    // amount is sent as a decimal BIRR string, not santim: 2000 santim = 20.00
    expect(call?.body).toMatchObject({
      amount: '20.00',
      currency: 'ETB',
      tx_ref: 'laqum-dep-abc123',
      callback_url: 'https://laqum.example/v1/webhooks/chapa',
      return_url: 'https://laqum.example/payment-complete',
      email: 'driver@example.com',
      first_name: 'Abebe',
    });
  });

  it('omits optional fields rather than sending nulls', async () => {
    const { provider, calls } = providerWith(() => ({
      status: 200,
      json: { status: 'success', data: { checkout_url: 'https://x' } },
    }));

    await provider.initialize({ txRef: 'laqum-dep-min', amountSantim: 100 });

    const body = calls[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['amount', 'currency', 'tx_ref']);
  });

  it('treats a response with no checkout_url as an outage, not a success', async () => {
    const { provider } = providerWith(() => ({
      status: 200,
      json: { status: 'failed', message: 'Invalid API Key' },
    }));

    await expect(provider.initialize({ txRef: 'x', amountSantim: 100 })).rejects.toSatisfy(
      isProviderUnavailable,
    );
  });
});

describe('verify', () => {
  const verifyBody = {
    status: 'success',
    message: 'Payment details',
    data: {
      first_name: 'Bilen',
      last_name: 'Gizachew',
      email: 'abebech_bekele@gmail.com',
      currency: 'ETB',
      amount: 100,
      charge: 3.5,
      mode: 'test',
      method: 'test',
      type: 'API',
      status: 'success',
      tx_ref: 'laqum-dep-abc123',
    },
  };

  it('GETs the documented URL and reads the documented fields', async () => {
    const { provider, calls } = providerWith(() => ({ status: 200, json: verifyBody }));

    const result = await provider.verify('laqum-dep-abc123');

    expect(calls[0]?.url).toBe('https://api.chapa.co/v1/transaction/verify/laqum-dep-abc123');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['Authorization']).toBe(`Bearer ${SECRET}`);

    expect(result.status).toBe('success');
    // 100 birr becomes 10000 santim; the 3.5 birr charge is reported
    // SEPARATELY and is not deducted.
    expect(result.amountSantim).toBe(10_000);
    expect(result.feeSantim).toBe(350);
    expect(result.currency).toBe('ETB');
    expect(result.txRef).toBe('laqum-dep-abc123');
  });

  it('url-encodes the reference', async () => {
    const { provider, calls } = providerWith(() => ({ status: 200, json: verifyBody }));
    await provider.verify('weird/ref?x=1');
    expect(calls[0]?.url).toBe('https://api.chapa.co/v1/transaction/verify/weird%2Fref%3Fx%3D1');
  });

  it('reads an unrecognised status as failed, never as success', async () => {
    const { provider } = providerWith(() => ({
      status: 200,
      json: { status: 'success', data: { ...verifyBody.data, status: 'something-new' } },
    }));
    expect((await provider.verify('x')).status).toBe('failed');
  });

  it('reports an unreadable amount as -1, which can never match a real row', async () => {
    const { provider } = providerWith(() => ({
      status: 200,
      json: { status: 'success', data: { ...verifyBody.data, amount: 'not-a-number' } },
    }));
    expect((await provider.verify('x')).amountSantim).toBe(-1);
  });

  it('treats a 404 as an answer and a 500 as an outage', async () => {
    const notFound = providerWith(() => ({
      status: 404,
      json: { status: 'failed', message: 'Transaction not found' },
    }));
    // Answered: "there is no such payment". Not an outage.
    const result = await notFound.provider.verify('missing');
    expect(result.status).toBe('failed');

    const broken = providerWith(() => ({ status: 500, json: { message: 'oops' } }));
    await expect(broken.provider.verify('x')).rejects.toSatisfy(isProviderUnavailable);
  });

  it('treats a transport failure as unavailable, never as a failed payment', async () => {
    const provider = new ChapaProvider({
      secretKey: SECRET,
      baseUrl: BASE,
      logger: testLogger(),
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    // The distinction that stops an outage expiring paid bookings.
    await expect(provider.verify('x')).rejects.toSatisfy(isProviderUnavailable);
  });
});

describe('refund', () => {
  const refundBody = {
    message: 'Refund verified successfully',
    status: 'success',
    data: {
      amount: 20,
      currency: 'ETB',
      ref_id: 'MERC-DIS-REF-HnIITWNXjNB',
      payment_reference: 'CGRMuqd8ECClEiS',
      status: 'initiated',
    },
  };

  it('POSTs to /v1/refund/<tx_ref> with a partial amount', async () => {
    const { provider, calls } = providerWith(() => ({ status: 200, json: refundBody }));

    const result = await provider.refund({
      txRef: 'laqum-dep-abc123',
      amountSantim: 1500,
      reason: 'late deposit',
      reference: 'laqum-refund-1',
    });

    expect(calls[0]?.url).toBe('https://api.chapa.co/v1/refund/laqum-dep-abc123');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({
      amount: '15.00',
      reason: 'late deposit',
      reference: 'laqum-refund-1',
    });

    expect(result.status).toBe('initiated');
    expect(result.refundReference).toBe('MERC-DIS-REF-HnIITWNXjNB');
  });

  it('omits amount for a full refund, which is how Chapa refunds everything', async () => {
    const { provider, calls } = providerWith(() => ({ status: 200, json: refundBody }));
    await provider.refund({ txRef: 'laqum-dep-abc123' });
    expect(calls[0]?.body).toEqual({});
  });

  it('reads the documented refund statuses', async () => {
    for (const status of ['initiated', 'processing', 'refunded', 'reversed']) {
      const { provider } = providerWith(() => ({
        status: 200,
        json: { status: 'success', data: { ...refundBody.data, status } },
      }));
      expect((await provider.refund({ txRef: 'x' })).status).toBe(status);
    }
  });
});
