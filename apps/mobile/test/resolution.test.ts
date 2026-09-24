import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE REACT, AND IT IS THE ONE REACT NATIVE EXPECTS.
 *
 * React Native ships a renderer compiled against a specific React version. If
 * the app and RN resolve DIFFERENT copies of react, it does not fail at
 * install or typecheck — it fails at runtime on the device, usually as an
 * inscrutable hook or dispatcher error. That is expensive to diagnose and
 * trivial to prevent, so it is asserted here.
 *
 * This is the constraint CLAUDE.md records: the peer range (`^19.2.3`) is
 * permissive, the renderer is not. The workspace legitimately contains two
 * react versions — the dashboard is on 19.3.0 — and pnpm's isolated linker is
 * what keeps them apart. This test proves that separation still holds.
 *
 * `expo install --fix` is the authority on which version that is: it
 * downgraded react-native from the registry's latest (0.87.1) to the 0.86.3
 * that SDK 57 actually bundles, and react to 19.2.3 with it.
 */

const require_ = createRequire(import.meta.url);

function resolveFrom(from: string, specifier: string): string {
  return require_.resolve(specifier, { paths: [from] });
}

function versionAt(packageJsonPath: string): string {
  return (require_(packageJsonPath) as { version: string }).version;
}

describe('react resolution', () => {
  const appReactPkg = resolveFrom(process.cwd(), 'react/package.json');
  const rnPkgPath = resolveFrom(process.cwd(), 'react-native/package.json');
  const rnReactPkg = resolveFrom(dirname(rnPkgPath), 'react/package.json');

  it('gives the app and React Native the SAME react instance', () => {
    // Same resolved FILE, not merely the same version string: two copies of
    // the same version are still two module instances with two dispatchers.
    expect(appReactPkg).toBe(rnReactPkg);
  });

  it('satisfies the version React Native declares', () => {
    const react = versionAt(appReactPkg);
    const peer = (require_(rnPkgPath) as { peerDependencies: Record<string, string> })
      .peerDependencies.react;

    expect(peer).toBeDefined();
    // The renderer wants an exact match; the declared range is the floor.
    expect(react).toBe(peer?.replace(/^\^/u, ''));
  });

  it('uses the react-native that Expo SDK 57 bundles, not the newest published', () => {
    // Pinned deliberately. RN publishes ahead of the SDK, and taking the
    // newer one silently breaks the prebuilt native modules in the dev build.
    expect(versionAt(rnPkgPath)).toBe('0.86.3');
  });
});

describe('safe-area resolution', () => {
  /*
   * useBottomInset (src/ui.tsx) reads the SafeAreaProvider that expo-router
   * mounts at the root. A context only reaches consumers importing the SAME
   * module instance, and pnpm gives a package one directory per resolved peer
   * set — the store holds three expo-router instances. If the app and its
   * expo-router ever resolve different copies, the app's hook finds no
   * provider, and Metro bundles a second copy that registers the native
   * RNCSafeAreaProvider view twice.
   */
  const appSafeArea = resolveFrom(process.cwd(), 'react-native-safe-area-context/package.json');
  const routerPkg = resolveFrom(process.cwd(), 'expo-router/package.json');
  const routerSafeArea = resolveFrom(
    dirname(routerPkg),
    'react-native-safe-area-context/package.json',
  );

  it('gives the app and its expo-router the SAME react-native-safe-area-context', () => {
    expect(appSafeArea).toBe(routerSafeArea);
  });

  it('is an expo-router that shares the app react, so its provider renders in the app tree', () => {
    expect(resolveFrom(dirname(routerPkg), 'react/package.json')).toBe(
      resolveFrom(process.cwd(), 'react/package.json'),
    );
  });
});
