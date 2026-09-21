import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // See db/vitest.config.ts: workspace packages resolve to source in
      // tests so `pnpm test` does not depend on build order.
      '@laqum/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
      '@laqum/db': fileURLToPath(new URL('../../db/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
