import { expect, test } from '@playwright/test';
import { hashOtp } from '../apps/api/src/auth/otp.js';
import { withDb } from './db.js';
import { FIRST_PAINT_BUDGET_MS, SEEDED_ATTENDANT_PHONE, reseed, skipIntro } from './fixtures.js';

/**
 * The dashboard's real sign-in: a code by SMS, through the OTP staff audience.
 *
 * Every other spec signs in with dev-login, which production never has; this
 * one drives the sign-in attendants will actually use. e2e cannot read an SMS
 * (the API prints codes to its own console), so once the screen has asked for
 * a code, the test replaces that code's hash with a known one — the API's own
 * hashOtp, so the stored form is exactly what the API writes. Everything the
 * screen and the API do is real.
 */

test.beforeAll(() => {
  reseed();
});

/** Replace the newest pending code for `phone` with `code`. */
async function plantCode(phone: string, code: string): Promise<void> {
  const codeHash = await hashOtp(code);
  await withDb(async (db) => {
    const row = await db
      .selectFrom('otp_codes')
      .select('id')
      .where('phone', '=', phone)
      .where('consumed_at', 'is', null)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('otp_codes')
      .set({ code_hash: codeHash })
      .where('id', '=', row.id)
      .execute();
  });
}

async function pendingCodes(phone: string): Promise<number> {
  return withDb(
    async (db) =>
      (await db.selectFrom('otp_codes').select('id').where('phone', '=', phone).execute()).length,
  );
}

test.beforeEach(async ({ page }) => {
  await skipIntro(page);
});

test('an attendant signs in with a code sent by SMS', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('otp-phone').fill(SEEDED_ATTENDANT_PHONE);
  await page.getByTestId('otp-send').click();
  await expect(page.getByTestId('otp-on-its-way')).toBeVisible();

  await plantCode(SEEDED_ATTENDANT_PHONE, '482913');
  await page.getByTestId('otp-code').fill('482913');
  await page.getByTestId('otp-verify').click();

  await expect(page.getByTestId('lot-grid')).toBeVisible({ timeout: FIRST_PAINT_BUDGET_MS });
});

test('a number that is not staff sees the same screen, gets no code, and cannot sign in', async ({
  page,
}) => {
  // A fresh number each run, so repeated local runs never meet the per-phone
  // rate limit (a number that never signs in never has it reset).
  const stranger = `+2519${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

  await page.goto('/');
  await page.getByTestId('otp-phone').fill(stranger);
  await page.getByTestId('otp-send').click();

  // The same "on its way" a staff number gets — and nothing was sent.
  await expect(page.getByTestId('otp-on-its-way')).toBeVisible();
  expect(await pendingCodes(stranger)).toBe(0);

  await page.getByTestId('otp-code').fill('123456');
  await page.getByTestId('otp-verify').click();
  await expect(page.getByTestId('otp-error')).toBeVisible();
  await expect(page.getByTestId('lot-grid')).toHaveCount(0);
});

test('offers dev sign-in beside it, because this test API runs with DEV_AUTH', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('otp-sign-in')).toBeVisible();
  await expect(page.getByTestId('sign-in')).toBeVisible();
});
