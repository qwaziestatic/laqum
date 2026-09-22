#!/usr/bin/env node
/**
 * Manual Chapa sandbox check. Real network, real test-mode money movement.
 * NEVER run in CI — every automated test uses FakePaymentProvider.
 *
 *   CHAPA_SECRET_KEY=CHASECK_TEST-xxxx node scripts/chapa-sandbox.mjs
 *   CHAPA_SECRET_KEY=... node scripts/chapa-sandbox.mjs verify <tx_ref>
 *
 * WHY THIS EXISTS
 *
 * Chapa's verify response carries BOTH `amount` and `charge`, and whether
 * `amount` is gross or net of Chapa's fee depends on the merchant's fee
 * settings. Our integrity check compares the verified amount against the
 * payments row exactly, so if `amount` came back net of the fee every payment
 * would be rejected.
 *
 * This script initialises a KNOWN amount, waits for you to pay with a test
 * card, then prints amount, charge and currency verbatim so the comparison can
 * be confirmed against the real service BEFORE any live use. Record the result
 * in CLAUDE.md under "Chapa sandbox findings".
 *
 * Test cards: https://developer.chapa.co/test/testing-cards
 */

const BASE = process.env.CHAPA_BASE_URL ?? 'https://api.chapa.co';
const SECRET = process.env.CHAPA_SECRET_KEY;

/** 20.00 ETB — the seeded Bole deposit, so the numbers are recognisable. */
const AMOUNT_BIRR = '20.00';
const EXPECTED_SANTIM = 2000;

if (!SECRET) {
  console.error('CHAPA_SECRET_KEY is not set. Use a TEST key (CHASECK_TEST-...).');
  process.exit(1);
}
if (!SECRET.includes('TEST')) {
  console.error(
    `Refusing to run: ${SECRET.slice(0, 12)}... does not look like a test key.\n` +
      'This script moves real money with a live key.',
  );
  process.exit(1);
}

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`HTTP ${res.status} from ${path}, non-JSON body:\n${text}`);
    process.exit(1);
  }
  return { status: res.status, json };
}

function reportVerify(json) {
  const data = json?.data ?? {};
  console.log('\n──────── VERIFY RESPONSE (record this in CLAUDE.md) ────────');
  console.log(`  status   : ${JSON.stringify(data.status)}`);
  console.log(`  amount   : ${JSON.stringify(data.amount)}   <-- compared against our row`);
  console.log(`  charge   : ${JSON.stringify(data.charge)}   <-- Chapa's fee, NOT deducted`);
  console.log(`  currency : ${JSON.stringify(data.currency)}`);
  console.log(`  mode     : ${JSON.stringify(data.mode)}`);
  console.log(`  tx_ref   : ${JSON.stringify(data.tx_ref ?? data.reference)}`);
  console.log('\n  full data:');
  console.log(JSON.stringify(data, null, 2));

  const amountSantim = Math.round(Number(data.amount) * 100);
  console.log('\n──────── THE QUESTION THIS SCRIPT ANSWERS ────────');
  console.log(`  We charged            : ${AMOUNT_BIRR} ETB (${EXPECTED_SANTIM} santim)`);
  console.log(`  Chapa reports amount  : ${data.amount} -> ${amountSantim} santim`);
  if (amountSantim === EXPECTED_SANTIM) {
    console.log('  RESULT: amount is GROSS. The exact-equality integrity check is correct.');
  } else {
    console.log(
      `  RESULT: amount does NOT equal what we charged (difference ` +
        `${EXPECTED_SANTIM - amountSantim} santim, charge=${data.charge}).\n` +
        '  The integrity check would REJECT every payment. Do not go live until this\n' +
        '  is understood — it likely means the merchant absorbs the fee and `amount`\n' +
        '  is net, in which case checkIntegrity must compare amount + charge.',
    );
  }

  // Also report which webhook signature headers arrive, once a webhook is
  // configured: our verifier deliberately requires x-chapa-signature only.
  console.log(
    '\n  NOTE: when you configure the webhook URL in the Chapa dashboard, check the\n' +
      '  request headers. We accept ONLY x-chapa-signature (payload-bound) and\n' +
      '  reject chapa-signature (an HMAC of the secret with itself, which is a\n' +
      '  constant and proves nothing about the body).',
  );
}

const [, , command, argument] = process.argv;

if (command === 'verify') {
  if (!argument) {
    console.error('Usage: node scripts/chapa-sandbox.mjs verify <tx_ref>');
    process.exit(1);
  }
  const { status, json } = await call(`/v1/transaction/verify/${encodeURIComponent(argument)}`);
  console.log(`HTTP ${status}`);
  reportVerify(json);
  process.exit(0);
}

const txRef = `laqum-sandbox-${Date.now().toString(36)}`;
console.log(`Initializing ${AMOUNT_BIRR} ETB with tx_ref=${txRef} against ${BASE}`);

const init = await call('/v1/transaction/initialize', {
  method: 'POST',
  body: JSON.stringify({
    amount: AMOUNT_BIRR,
    currency: 'ETB',
    tx_ref: txRef,
    email: 'sandbox@laqum.test',
    first_name: 'Sandbox',
    last_name: 'Driver',
    callback_url: process.env.PUBLIC_BASE_URL
      ? `${process.env.PUBLIC_BASE_URL}/v1/webhooks/chapa`
      : undefined,
  }),
});

console.log(`HTTP ${init.status}`);
console.log(JSON.stringify(init.json, null, 2));

const checkoutUrl = init.json?.data?.checkout_url;
if (!checkoutUrl) {
  console.error('\nNo checkout_url returned. Check the key and the response above.');
  process.exit(1);
}

console.log('\n──────── NEXT ────────');
console.log(`  1. Open: ${checkoutUrl}`);
console.log('  2. Pay with a Chapa test card: https://developer.chapa.co/test/testing-cards');
console.log(`  3. Then run: CHAPA_SECRET_KEY=... node scripts/chapa-sandbox.mjs verify ${txRef}`);
console.log('  4. Record the amount/charge/currency result in CLAUDE.md.');
