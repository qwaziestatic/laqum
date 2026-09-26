import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for the attendant dashboard.
 *
 * The whole stack runs for real: Postgres, Redis, the API with its Socket.io
 * server, and the dashboard behind Vite's proxy. Nothing here is mocked —
 * the point of these tests is precisely the parts the unit tests cannot
 * reach, namely a browser holding a live socket.
 *
 * PORTS are deliberately not the dev ports. A running `pnpm dev` stack must
 * not be able to collide with an e2e run, and an e2e run must never point at
 * the development database.
 */

const API_PORT = 3100;
/*
 * 5673, not 5273.
 *
 * Windows reserves several TCP ranges for Hyper-V and WinNAT — on this machine
 * 5199-5298 among them — and binding inside one fails with EACCES, which reads
 * like a permissions problem rather than "that port is spoken for".
 * `netsh interface ipv4 show excludedportrange protocol=tcp` lists them.
 */
const WEB_PORT = 5673;

const isCI = Boolean(process.env['CI']);

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://laqum:laqum@localhost:55432/laqum_test';
const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:56379';

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  fullyParallel: false,
  // A retry in CI absorbs a genuinely flaky container start; locally a
  // failure should be a failure, so it is seen and fixed.
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? [['github'], ['list']] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    video: isCI ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'tablet',
      use: {
        ...devices['Desktop Chrome'],
        /*
         * A 10" landscape tablet, which is what this is actually mounted on.
         * Screenshots are taken at this size so the review is of the layout
         * the attendant sees, not a desktop window.
         */
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        hasTouch: true,
        // MUST be Playwright's bundled Chromium. Stable Chrome and Edge both
        // restrict the flags these tests rely on.
        channel: 'chromium',
      },
    },
  ],

  webServer: [
    {
      /*
       * The COMPILED API — `node dist/server.js`, exactly what ships.
       *
       * Deliberately not tsx. e2e is the last gate before a release, so it
       * should exercise the same resolution production uses: bare specifiers
       * resolved through each workspace package's `import`/`default` export
       * condition, which points at dist/. Running it from source here would
       * have meant the build was never exercised by a running process, and a
       * broken dist would reach production untested.
       *
       * `pnpm e2e` builds first, so dist is always current — see the root
       * package.json script.
       *
       * DEV_AUTH=true is safe here and nowhere else: NODE_ENV is not
       * production, and the config refuses to enable dev login in production
       * regardless of this flag.
       */
      command: 'pnpm --filter @laqum/api start',
      port: API_PORT,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        LOG_LEVEL: 'warn',
        DATABASE_URL: TEST_DATABASE_URL,
        REDIS_URL: TEST_REDIS_URL,
        DEV_AUTH: 'true',
        PAYMENT_PROVIDER: 'fake',
        // The fake provider's checkout page is served by this API; drivers
        // are sent to it at its public address (e2e/dev-checkout.spec.ts).
        PUBLIC_BASE_URL: `http://localhost:${String(API_PORT)}`,
        // The sweeper and job workers are Phase 1's concern and add noise
        // here; the dashboard tests drive transitions through the API.
        RUN_WORKER: 'false',
      },
    },
    {
      /*
       * `vite preview` serves the BUILT bundle, for the same reason the API is
       * the compiled one: the dev server is not what ships.
       *
       * --host localhost: the config binds 0.0.0.0 for device testing, which
       * a test run neither needs nor should expose.
       */
      command: `pnpm --filter @laqum/dashboard exec vite preview --port ${String(WEB_PORT)} --strictPort --host localhost`,
      port: WEB_PORT,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // Vite proxies /v1 and /socket.io here, so the browser only ever
        // talks to one origin — no CORS, no mixed content.
        VITE_API_TARGET: `http://localhost:${String(API_PORT)}`,
      },
    },
  ],
});
