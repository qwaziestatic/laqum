import { type Page, expect, test } from '@playwright/test';
import {
  FIRST_PAINT_BUDGET_MS,
  PIASSA,
  SEEDED_ATTENDANT_PHONE,
  reseed,
  setLanguage,
  signIn,
} from './fixtures.js';

/**
 * THE DASHBOARD'S OPENING ANIMATION, in a real browser.
 *
 * The product owner's rules: once per browser session (not on a reload,
 * never on a realtime reconnect); at most 800 ms; never delaying sign-in or
 * the connection; reduced motion respected; decorative, with the page named
 * properly. Unit tests (apps/dashboard/src/intro.test.ts) pin the numbers;
 * this pins the behaviour.
 *
 * With BRAND_PREVIEWS=1 it also saves frames to docs/brand-previews/, for
 * review without running anything. They are evidence, not a baseline.
 */

const PREVIEWS = process.env['BRAND_PREVIEWS'] === '1';

/** Counts every time the intro is put into the page, from the first byte. */
async function watchIntro(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { introSeen: number };
    w.introSeen = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.dataset['testid'] === 'intro') w.introSeen += 1;
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

/**
 * Stop the page's timers before it loads, so the intro stays until the test
 * moves time on. `install` alone does not stop time; `pauseAt` does.
 */
async function freezeTimers(page: Page): Promise<void> {
  const start = new Date('2026-01-01T06:00:00.000Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1));
}

const introSeen = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { introSeen: number }).introSeen);

test.beforeAll(() => {
  reseed();
});

test('plays when the browser session starts, and is gone within 800 ms', async ({ page }) => {
  await watchIntro(page);
  await page.goto('/');
  const intro = page.getByTestId('intro');
  await expect(intro).toBeVisible({ timeout: FIRST_PAINT_BUDGET_MS });
  await expect(intro).toHaveAttribute('aria-hidden', 'true');
  // 800 ms is the component's own timer; the margin is the browser's, not ours.
  await expect(intro).toHaveCount(0, { timeout: 1_500 });
  expect(await introSeen(page)).toBe(1);
});

test('does not play again on a reload in the same session', async ({ page }) => {
  await watchIntro(page);
  await page.goto('/');
  await expect(page.getByTestId('intro')).toHaveCount(0, { timeout: FIRST_PAINT_BUDGET_MS });

  await page.reload();
  await expect(page.getByTestId('sign-in')).toBeVisible({ timeout: FIRST_PAINT_BUDGET_MS });
  await page.waitForTimeout(1_000);
  expect(await introSeen(page)).toBe(0);
});

test('plays again in a new browser session', async ({ browser }) => {
  for (let session = 0; session < 2; session++) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.getByTestId('intro')).toBeVisible({ timeout: FIRST_PAINT_BUDGET_MS });
    } finally {
      await context.close();
    }
  }
});

test('never delays sign-in: the form is usable underneath while it plays', async ({ page }) => {
  // Freeze the page's timers so the intro stays put while we use the form.
  await freezeTimers(page);
  await page.goto('/');
  const intro = page.getByTestId('intro');
  await expect(intro).toBeVisible({ timeout: FIRST_PAINT_BUDGET_MS });

  const phone = page.getByTestId('sign-in-phone');
  await phone.click();
  await phone.fill(SEEDED_ATTENDANT_PHONE);
  await expect(phone).toHaveValue(SEEDED_ATTENDANT_PHONE);
  await expect(intro).toBeVisible();
});

test('never plays on a realtime reconnect', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await watchIntro(page);
    await page.goto('/');
    await expect(page.getByTestId('intro')).toHaveCount(0, { timeout: FIRST_PAINT_BUDGET_MS });

    await page.getByTestId('sign-in-phone').fill(SEEDED_ATTENDANT_PHONE);
    await page.getByTestId('sign-in-submit').click();
    await expect(page.getByTestId('lot-grid')).toBeVisible({ timeout: FIRST_PAINT_BUDGET_MS });
    await page.getByTestId('lot-picker').selectOption({ label: PIASSA });
    const indicator = page.getByTestId('connection-indicator');
    await expect(indicator).toHaveAttribute('data-connection', 'live', {
      timeout: FIRST_PAINT_BUDGET_MS,
    });

    // The same drop two-screen.spec.ts uses: the socket notices, then resyncs.
    await context.setOffline(true);
    await expect(indicator).not.toHaveAttribute('data-connection', 'live', { timeout: 25_000 });
    await context.setOffline(false);
    await expect(indicator).toHaveAttribute('data-connection', 'live', { timeout: 30_000 });

    expect(await introSeen(page)).toBe(1);
  } finally {
    await context.close();
  }
});

test('with reduced motion, shows a still frame briefly and animates nothing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await freezeTimers(page);
  await page.goto('/');
  const intro = page.getByTestId('intro');
  await expect(intro).toHaveAttribute('data-reduced-motion', 'true', {
    timeout: FIRST_PAINT_BUDGET_MS,
  });
  const running = await page.evaluate(
    () => document.getAnimations().filter((a) => a.playState === 'running').length,
  );
  expect(running).toBe(0);
  await page.clock.runFor(300);
  await expect(intro).toHaveCount(0);
});

test('names the page in the current language, and carries the favicon', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page).toHaveTitle('ላቁም? — የአስተናጋጅ ማዕከል', { timeout: FIRST_PAINT_BUDGET_MS });
  await expect(page.locator('html')).toHaveAttribute('lang', 'am');
  // The language switch is in the signed-in header; the name follows it.
  await signIn(page);
  await setLanguage(page, 'en');
  await expect(page).toHaveTitle('Laqum — Attendant console');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await setLanguage(page, 'am');
  await expect(page).toHaveTitle('ላቁም? — የአስተናጋጅ ማዕከል');

  const icons = [
    { selector: 'link[rel="icon"][type="image/svg+xml"]', type: 'image/svg+xml' },
    { selector: 'link[rel="icon"][sizes="32x32"]', type: 'image/png' },
    { selector: 'link[rel="icon"][sizes="16x16"]', type: 'image/png' },
    { selector: 'link[rel="apple-touch-icon"]', type: 'image/png' },
  ];
  for (const { selector, type } of icons) {
    const href = await page.locator(selector).getAttribute('href');
    expect(href, selector).toBeTruthy();
    const res = await request.get(href ?? '');
    expect(res.status(), selector).toBe(200);
    expect(res.headers()['content-type'], selector).toContain(type);
  }
});

test.describe('review frames', () => {
  test.skip(!PREVIEWS, 'set BRAND_PREVIEWS=1 to write docs/brand-previews/');

  for (const theme of ['light', 'dark'] as const) {
    test(`the dashboard intro, ${theme}`, async ({ page }) => {
      await page.addInitScript((value) => {
        localStorage.setItem('laqum:theme', value);
      }, theme);
      await freezeTimers(page);
      await page.goto('/');
      await expect(page.getByTestId('intro')).toBeVisible({ timeout: FIRST_PAINT_BUDGET_MS });
      // Frames at chosen moments of the CSS animations, held still.
      for (const ms of [0, 300, 650]) {
        await page.evaluate((at) => {
          for (const animation of document.getAnimations()) {
            animation.pause();
            animation.currentTime = at;
          }
        }, ms);
        await page.screenshot({
          path: `docs/brand-previews/dashboard-intro-${theme}-${String(ms).padStart(3, '0')}ms.png`,
        });
      }
    });
  }
});
