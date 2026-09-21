import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Vite 8's defineConfig has no `test` key, so Vitest gets its own config and
// reuses the Vite one for plugins and aliases.
export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      alias: {
        '@laqum/shared': fileURLToPath(
          new URL('../../packages/shared/src/index.ts', import.meta.url),
        ),
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
  }),
);
