import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace packages to TypeScript source in tests.
      //
      // @laqum/shared's "exports" point runtime consumers at dist/, which only
      // exists after a build. Aliasing to source keeps `pnpm test` independent
      // of build order. CI additionally runs `pnpm build`, so the dist path is
      // exercised too, and the api Docker image only ever uses dist.
      '@laqum/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Integration tests talk to a real Postgres. They share one database and
    // reset its schema, so they must not run concurrently against each other.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
