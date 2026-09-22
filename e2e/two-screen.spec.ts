import { expect, test } from '@playwright/test';
import { REALTIME_BUDGET_MS, reseed, signIn, slot, statusOf } from './fixtures.js';

/**
 * THE TWO-SCREEN TEST.
 *
 * Two attendants, two browsers, one lot. One parks a car; the other's grid
 * must change without a refresh. This is the only test in the suite that
 * exercises the whole path end to end — HTTP, the Postgres commit, the
 * after-commit emit, Socket.io, and the client's version ordering — in a real
 * browser.
 *
 * TIMING. The budget is REALTIME_BUDGET_MS from fixtures.ts:
 *   local: 1000ms — strict, because the whole path is sub-100ms on one
 *          machine and a regression should show up as a failure;
 *   CI:    5000ms — loose, because a shared runner's scheduler jitter is not
 *          a product defect, and a flaky e2e test gets ignored, which is a
 *          worse outcome than a slow one.
 * The elapsed time is measured and reported either way, so a creeping
 * regression is visible in the log long before it breaches the budget.
 */

test.describe('two screens, one lot', () => {
  test.beforeAll(() => {
    reseed();
  });

  test('a walk-in parked on screen A appears on screen B without a refresh', async ({
    browser,
  }) => {
    // Two genuinely separate browser contexts: separate cookies, separate
    // storage, separate sockets. Two tabs would share a service worker and
    // could mask a per-connection bug.
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const screenA = await contextA.newPage();
      const screenB = await contextB.newPage();

      await signIn(screenA);
      await signIn(screenB);

      // Pick a slot that is free on BOTH screens before anything happens.
      const label = 'G-1';
      expect(await statusOf(screenA, label)).toBe('free');
      expect(await statusOf(screenB, label)).toBe('free');

      const freeBefore = await screenB.getByTestId('count-free').getAttribute('data-count');

      // Screen B is watching. It never interacts.
      const changed = screenB
        .locator(`[data-testid="slot-${label}"][data-status="occupied"]`)
        .waitFor({ state: 'visible', timeout: REALTIME_BUDGET_MS });

      const startedAt = Date.now();

      // Screen A parks a car. TWO TAPS: the tile, then the action.
      await slot(screenA, label).click();
      await screenA.getByTestId('walk-in-plate').fill('AA-33333');
      await screenA.getByTestId('action-park').click();

      await changed;
      const elapsed = Date.now() - startedAt;

      // Reported whether or not it passed, so a creeping regression is
      // visible in the log before it breaches the budget.
      test.info().annotations.push({
        type: 'realtime-latency',
        description: `${String(elapsed)}ms (budget ${String(REALTIME_BUDGET_MS)}ms)`,
      });
      console.log(
        `two-screen realtime latency: ${String(elapsed)}ms (budget ${String(REALTIME_BUDGET_MS)}ms)`,
      );
      expect(elapsed).toBeLessThan(REALTIME_BUDGET_MS);

      // The plate reached the STAFF screen, which is what the staff room is
      // for — and the header count followed the grid.
      await expect(screenB.getByTestId(`slot-${label}`)).toContainText('AA-33333');
      await expect(screenB.getByTestId('count-free')).not.toHaveAttribute(
        'data-count',
        freeBefore ?? '',
      );

      // Screen B was never reloaded. If it had been, this test would prove
      // nothing about realtime.
      expect(screenB.url()).toContain('/');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('a check-out on screen A frees the slot on screen B', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const screenA = await contextA.newPage();
      const screenB = await contextB.newPage();
      await signIn(screenA);
      await signIn(screenB);

      const label = 'G-2';

      // Park it first, from A.
      await slot(screenA, label).click();
      await screenA.getByTestId('action-park').click();
      await expect(screenA.getByTestId(`slot-${label}`)).toHaveAttribute('data-status', 'occupied');

      // Close the drawer before touching the grid again: it is a modal with a
      // full-screen scrim, so a tile click underneath would hit the scrim.
      await screenA.getByTestId('drawer-close').click();
      await expect(screenA.getByTestId('slot-drawer')).toBeHidden();

      // B sees it occupied.
      await expect(screenB.getByTestId(`slot-${label}`)).toHaveAttribute(
        'data-status',
        'occupied',
        {
          timeout: REALTIME_BUDGET_MS,
        },
      );

      // A checks it out. Two taps: the tile, then the action.
      const freed = screenB
        .locator(`[data-testid="slot-${label}"][data-status="free"]`)
        .waitFor({ state: 'visible', timeout: REALTIME_BUDGET_MS });

      await slot(screenA, label).click();
      await screenA.getByTestId('action-check-out').click();

      await freed;
      await expect(screenB.getByTestId(`slot-${label}`)).not.toContainText('AA-');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('taking a slot out of service reaches the other screen', async ({ browser }) => {
    // in_service is the one slot change with no booking behind it, so it is
    // the emit most likely to be forgotten. Worth its own screen-to-screen
    // check.
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const screenA = await contextA.newPage();
      const screenB = await contextB.newPage();
      await signIn(screenA);
      await signIn(screenB);

      const label = 'G-3';
      const changed = screenB
        .locator(`[data-testid="slot-${label}"][data-status="out_of_service"]`)
        .waitFor({ state: 'visible', timeout: REALTIME_BUDGET_MS });

      await slot(screenA, label).click();
      await screenA.getByTestId('action-out-of-service').click();

      await changed;
      await expect(screenB.getByTestId('count-out_of_service')).not.toHaveAttribute(
        'data-count',
        '0',
      );
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

test.describe('the view says when it cannot be trusted', () => {
  test.beforeAll(() => {
    reseed();
  });

  test('shows reconnecting when the socket drops, then resyncs', async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await signIn(page);

      await expect(page.getByTestId('connection-indicator')).toHaveAttribute(
        'data-connection',
        'live',
      );

      /*
       * Drop the connection the way a lost network does.
       *
       * The server pings every 10s with a 5s timeout, so the worst case for
       * noticing is ~15s; 25s gives that headroom without hiding a
       * regression. The defaults would have been ~45s, which is why they
       * were lowered — see realtime/server.ts.
       */
      await context.setOffline(true);
      await expect(page.getByTestId('connection-indicator')).not.toHaveAttribute(
        'data-connection',
        'live',
        { timeout: 25_000 },
      );

      await context.setOffline(false);

      // And it comes back by itself, with a fresh snapshot — not by the
      // attendant noticing and reloading.
      await expect(page.getByTestId('connection-indicator')).toHaveAttribute(
        'data-connection',
        'live',
        { timeout: 30_000 },
      );
      await expect(page.getByTestId('lot-grid')).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
