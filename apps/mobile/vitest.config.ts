import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the parts that do NOT need a device.
 *
 * Deliberately node, not jsdom or a React Native preset: everything tested
 * here is pure logic — the refresh state machine, the location gate, the
 * server clock, the deep-link chain. Screens and native modules are verified
 * on the device, and the device-test script says which.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@laqum/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
});
