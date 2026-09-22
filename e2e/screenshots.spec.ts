import { expect, test } from '@playwright/test';
import { seedDisplayStates } from './db.js';
import { PIASSA, reseed, setLanguage, setTheme, signIn, slot } from './fixtures.js';

/**
 * Screenshots for review, saved under e2e/screenshots/.
 *
 * These exist so the UI can be reviewed without running anything. They are
 * NOT visual-regression assertions — there is no baseline to compare against,
 * and a pixel-diff gate on a UI this young would fail on every legitimate
 * change. They are evidence.
 *
 * The lot is driven into ALL FIVE slot states first, so a reviewer can see
 * every status side by side and judge whether they are distinguishable —
 * which is the actual requirement, and not something a test can assert.
 */

const SHOTS = 'e2e/screenshots';

test.describe('UI screenshots', () => {
  /*
   * Per TEST, not per file: each screenshot drives the lot into a specific
   * arrangement, and the seeded RESERVED/OVERSTAY bookings would collide with
   * one_live_booking_per_slot on the second theme's run.
   */
  test.beforeEach(() => {
    reseed();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`lot view with all five slot states — ${theme}`, async ({ page }) => {
      /*
       * Two slots are seeded BEFORE signing in, and two are driven through
       * the UI afterwards:
       *
       *   free           G-1, left alone
       *   occupied       G-2, walk-in parked through the dashboard
       *   out_of_service G-3, taken out of service through the dashboard
       *   overstay       G-4, seeded — created by the passage of time
       *   reserved       H-1, seeded — created by a driver in the mobile app
       *
       * Labels advance the ROW letter, so the ground zone is G-1..G-4 then
       * H-1..H-4 — there is no G-5.
       *
       * The last two are not attendant actions, so producing them through the
       * dashboard would misrepresent what the dashboard does. Seeding them
       * first means the snapshot at sign-in already contains them, with no
       * reload (which would drop the in-memory session).
       */
      await seedDisplayStates(PIASSA, {
        reservedSlotLabel: 'H-1',
        overstaySlotLabel: 'G-4',
      });

      await signIn(page);
      await setTheme(page, theme);
      await setLanguage(page, 'en');

      await expect(page.getByTestId('slot-G-4')).toHaveAttribute('data-status', 'overstay');
      await expect(page.getByTestId('slot-H-1')).toHaveAttribute('data-status', 'reserved');

      // occupied
      await slot(page, 'G-2').click();
      await page.getByTestId('walk-in-plate').fill('AA-10002');
      await page.getByTestId('action-park').click();
      await expect(page.getByTestId('slot-G-2')).toHaveAttribute('data-status', 'occupied');
      await page.getByTestId('drawer-close').click();

      // out of service
      await slot(page, 'G-3').click();
      await page.getByTestId('action-out-of-service').click();
      await expect(page.getByTestId('slot-G-3')).toHaveAttribute('data-status', 'out_of_service');
      await page.getByTestId('drawer-close').click();

      // And G-1 is untouched, so all five are on screen at once.
      await expect(page.getByTestId('slot-G-1')).toHaveAttribute('data-status', 'free');

      // All five, in one frame.
      await page.screenshot({
        path: `${SHOTS}/lot-view-all-states-${theme}.png`,
        fullPage: false,
      });

      // The header on its own, so the counters can be read.
      await page.locator('header').screenshot({ path: `${SHOTS}/header-${theme}.png` });
    });

    test(`slot drawer — ${theme}`, async ({ page }) => {
      await signIn(page);
      await setTheme(page, theme);
      await setLanguage(page, 'en');

      // An occupied slot shows the most: plate, deadline, and the actions.
      await slot(page, 'H-2').click();
      await page.getByTestId('walk-in-plate').fill('AA-77777');
      await page.getByTestId('action-park').click();
      await expect(page.getByTestId('slot-H-2')).toHaveAttribute('data-status', 'occupied');

      /*
       * The drawer stays open and re-renders as "occupied" on its own: it
       * reads the slot from the store by id rather than holding a copy, so
       * the realtime event updates it in place. No second click is needed,
       * and a click here would land on the drawer's own scrim anyway.
       */
      await expect(page.getByTestId('slot-drawer')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/slot-drawer-occupied-${theme}.png` });

      // And a free one, which is where a walk-in starts.
      await page.getByTestId('drawer-close').click();
      await slot(page, 'H-3').click();
      await expect(page.getByTestId('slot-drawer')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/slot-drawer-free-${theme}.png` });
    });

    test(`scanner and short code — ${theme}`, async ({ page }) => {
      await signIn(page);
      await setTheme(page, theme);
      await setLanguage(page, 'en');

      /*
       * There is no camera in a headless browser, so the scanner renders its
       * unavailable state. That is deliberately the state worth reviewing: it
       * is what an attendant sees when the camera fails, and it has to point
       * them at the short code rather than leaving them stuck.
       */
      await page.getByTestId('scan-button').click();
      await expect(page.getByTestId('qr-scanner')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/scanner-${theme}.png` });
      await page.getByTestId('scanner-close').click();

      await page.getByTestId('short-code-button').click();
      await expect(page.getByTestId('short-code-entry')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/short-code-${theme}.png` });
    });

    test(`amharic lot view — ${theme}`, async ({ page }) => {
      // The Amharic view is the default for most users, so it is reviewed
      // alongside the English one rather than as an afterthought.
      await signIn(page);
      await setTheme(page, theme);
      await setLanguage(page, 'am');
      await expect(page.getByTestId('lot-grid')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/lot-view-amharic-${theme}.png` });
    });
  }
});
