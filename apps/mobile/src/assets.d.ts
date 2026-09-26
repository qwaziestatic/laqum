/*
 * Images are imported, not required: Metro turns either into an asset
 * reference (picking @2x/@3x by density), and an import keeps lint's
 * no-require-imports rule meaningful everywhere else.
 */
declare module '*.jpg' {
  import type { ImageSourcePropType } from 'react-native';

  const source: ImageSourcePropType;
  export default source;
}

declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native';

  const source: ImageSourcePropType;
  export default source;
}
