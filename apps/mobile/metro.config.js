const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Expo SDK 57's default config ALREADY handles this pnpm monorepo.
 *
 * Verified, not assumed: with no metro.config.js at all, `expo export
 * --platform android` bundled successfully, resolving @laqum/shared across
 * pnpm's symlinked store. So there are deliberately no `watchFolders`, no
 * `nodeModulesPaths` and no `unstable_enableSymlinks` here — they were not
 * needed, and config that does nothing is config that misleads.
 *
 * TWO settings ARE needed, both to bundle @laqum/shared from SOURCE. Each was
 * added only after a real bundle failed without it.
 */
const config = getDefaultConfig(__dirname);

/*
 * (1) Take the `development` export condition.
 *
 * Without it:
 *
 *   While trying to resolve module `@laqum/shared` ... the package itself
 *   specifies a `main` module field that could not be resolved
 *
 * because @laqum/shared's exports map sends `import`/`default` to dist/.
 * Metro would then demand a prior `pnpm build` and break whenever dist was
 * stale or absent — the same dual-resolution hazard that broke CI's e2e job.
 * Source is also simply correct for a bundler: Metro compiles TypeScript
 * itself, so dist/ offers it nothing but staleness.
 */
config.resolver.unstable_conditionNames = ['development', 'require', 'import', 'react-native'];

/*
 * (2) Map the `.js` specifiers in that source onto the `.ts` files on disk.
 *
 * Without it:
 *
 *   Unable to resolve module ./billing.js from packages/shared/src/index.ts
 *
 * The shared source writes `./billing.js` because Node's ESM resolution —
 * which the API and db rely on under tsx — requires the extension, and
 * TypeScript never rewrites specifiers. tsx and Vite both map it back to
 * `.ts` transparently; Metro does not, so this does it for them.
 *
 * Scoped deliberately: RELATIVE specifiers only, and only when a sibling .ts
 * or .tsx actually exists. A real `.js` file on disk still wins, so nothing in
 * node_modules is affected.
 */
const TS_EXTENSIONS = ['.ts', '.tsx'];

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    const origin = context.originModulePath;
    const candidateBase = path.resolve(path.dirname(origin), moduleName.slice(0, -'.js'.length));

    // Only rewrite when the .js does NOT exist and a .ts sibling does.
    if (!fs.existsSync(`${candidateBase}.js`)) {
      for (const extension of TS_EXTENSIONS) {
        const candidate = `${candidateBase}${extension}`;
        if (fs.existsSync(candidate)) {
          return { type: 'sourceFile', filePath: candidate };
        }
      }
    }
  }

  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
