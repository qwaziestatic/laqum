import { execFileSync } from 'node:child_process';
import { type Locator, type Page, type Response, expect, test } from '@playwright/test';

/**
 * Shared e2e helpers.
 *
 * TIMING THRESHOLDS are stated here once, in both environments, and are
 * asserted rather than assumed:
 *
 *   REALTIME_BUDGET_MS — how long a change may take to appear on a SECOND
 *   screen. Locally this is strict, because on one machine the whole path
 *   (HTTP → Postgres commit → Socket.io → Redis adapter → browser) is
 *   sub-100ms in practice and a regression should be visible. In CI it is
 *   loose, because a shared runner's scheduler jitter is not a product
 *   defect and a flaky e2e test gets ignored, which is worse than a slow one.
 */
export const REALTIME_BUDGET_MS = process.env['CI'] ? 5_000 : 1_000;

/**
 * How long screen B took to show a change, measured from the moment the
 * SERVER CONFIRMED screen A's action (A's request came back) to the moment B
 * shows it. That is the realtime path and nothing else.
 *
 * The budget used to start before screen A's clicks, so clicking, typing and
 * a slow machine counted against it, and "taking a slot out of service"
 * failed once while realtime was fine. The waits themselves are generous;
 * only the measured latency is held to REALTIME_BUDGET_MS. B can show the
 * change before A's response reaches the test (the event overtook it): that
 * counts as zero.
 */
export async function realtimeLatency(options: {
  screenA: Page;
  /** Which of screen A's responses confirms the action. */
  confirms: (response: Response) => boolean;
  act: () => Promise<void>;
  screenBShows: Locator;
}): Promise<number> {
  const WAIT_MS = 30_000;
  const confirmed = options.screenA
    .waitForResponse(options.confirms, { timeout: WAIT_MS })
    .then((response) => {
      expect(response.ok(), `the action itself failed: HTTP ${String(response.status())}`).toBe(
        true,
      );
      return Date.now();
    });
  const shown = options.screenBShows
    .waitFor({ state: 'visible', timeout: WAIT_MS })
    .then(() => Date.now());

  await options.act();
  const [confirmedAt, shownAt] = await Promise.all([confirmed, shown]);
  const latency = Math.max(0, shownAt - confirmedAt);

  // Reported whether or not it passes, so a creeping regression shows in the
  // log before it breaches the budget.
  test.info().annotations.push({
    type: 'realtime-latency',
    description: `${String(latency)}ms (budget ${String(REALTIME_BUDGET_MS)}ms)`,
  });
  console.log(`realtime latency: ${String(latency)}ms (budget ${String(REALTIME_BUDGET_MS)}ms)`);
  return latency;
}

/** A response to a request whose method and path match. */
export function responseTo(method: string, pathPart: string): (response: Response) => boolean {
  return (response) => response.request().method() === method && response.url().includes(pathPart);
}

/** How long a first paint may take, which is dominated by the dev-server build. */
export const FIRST_PAINT_BUDGET_MS = process.env['CI'] ? 30_000 : 15_000;

export const SEEDED_ATTENDANT_PHONE = '+251911000001';
export const SEEDED_DRIVER_PHONE = '+251911000002';

/** The zero-deposit lot, so bookings go straight to RESERVED. */
export const PIASSA = 'Piassa Central Parking';

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://laqum:laqum@localhost:55432/laqum_test';

/**
 * Re-seed the database to a known state.
 *
 * Runs the real seed script rather than a test-only fixture, so these tests
 * exercise the same data an operator would actually get — and so a broken
 * seed fails here rather than in someone's first demo.
 */
export function reseed(): void {
  // Playwright runs from the repo root, so a relative filter is enough — and
  // avoids turning an import.meta.url into a Windows path, which needs a
  // drive-letter fixup that is easy to get subtly wrong.
  execFileSync('pnpm', ['--filter', '@laqum/db', 'seed'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, NODE_ENV: 'test' },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}

/**
 * Sign in through the dev endpoint, select the lot, and wait for it to be live.
 *
 * The lot is chosen EXPLICITLY. The seeded attendant staffs two lots and the
 * console opens on whichever comes back first, so a test that assumed the
 * default would be testing the sort order of /staff/lots.
 */
export async function signIn(
  page: Page,
  phone = SEEDED_ATTENDANT_PHONE,
  lotName = PIASSA,
): Promise<void> {
  await page.goto('/');
  await page.getByTestId('sign-in-phone').fill(phone);
  await page.getByTestId('sign-in-submit').click();

  await expect(page.getByTestId('lot-grid')).toBeVisible({ timeout: FIRST_PAINT_BUDGET_MS });
  await page.getByTestId('lot-picker').selectOption({ label: lotName });
  // Not merely rendered — actually receiving events. Asserting on the
  // indicator means a test can never pass against a dead socket.
  await expect(page.getByTestId('connection-indicator')).toHaveAttribute(
    'data-connection',
    'live',
    { timeout: FIRST_PAINT_BUDGET_MS },
  );
}

/**
 * Choose the language explicitly.
 *
 * Amharic is the DEFAULT, so a screenshot that does not say otherwise is an
 * Amharic screenshot — which is correct for users and misleading in a review
 * set that is supposed to show both.
 */
export async function setLanguage(page: Page, locale: 'am' | 'en'): Promise<void> {
  await page.getByTestId(`lang-${locale}`).click();
  await expect(page.getByTestId(`lang-${locale}`)).toHaveAttribute('aria-pressed', 'true');
}

/** Set the theme deterministically, for screenshots. */
export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    localStorage.setItem('laqum:theme', value);
    document.documentElement.dataset['theme'] = value;
    document.documentElement.style.colorScheme = value;
  }, theme);
}

/** A slot tile by its label, e.g. "G-1". */
export function slot(page: Page, label: string) {
  return page.getByTestId(`slot-${label}`);
}

export async function statusOf(page: Page, label: string): Promise<string | null> {
  return slot(page, label).getAttribute('data-status');
}
