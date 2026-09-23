import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * HTTPS IN DEVELOPMENT, AND WHY THE API DOES NOT NEED A CERTIFICATE.
 *
 * `navigator.mediaDevices` is undefined outside a secure context, so the QR
 * scanner cannot work over plain http on a phone or tablet on the LAN
 * (localhost is exempt, which is why it works on the dev machine and fails on
 * the device — a genuinely confusing failure).
 *
 * The fix is a locally-trusted certificate from mkcert for THIS server only.
 * The API stays on plain http, because everything the page fetches goes
 * through the proxy below: the browser only ever talks to this origin, so
 * there is no mixed content and no second certificate to trust. See
 * README.md, "Camera access in development".
 *
 * Certificates are optional: without them the server runs over http and the
 * scanner falls back to the manual short code, which is a supported tier.
 */
const certDir = fileURLToPath(new URL('./certs/', import.meta.url));
const keyPath = `${certDir}localhost-key.pem`;
const certPath = `${certDir}localhost.pem`;
const hasCerts = existsSync(keyPath) && existsSync(certPath);

const API_TARGET = process.env['VITE_API_TARGET'] ?? 'http://localhost:3000';

/**
 * Shared by `server` and `preview`.
 *
 * Everything the page fetches goes through here, so the browser only ever
 * talks to this origin: no CORS, and no second certificate to trust when the
 * dev server is on https.
 */
const PROXY = {
  '/v1': { target: API_TARGET, changeOrigin: true },
  // ws: true is REQUIRED. Without it the proxy handles the initial polling
  // handshake and then silently fails the upgrade, so the socket falls back
  // to long-polling and reconnects forever without an obvious error.
  '/socket.io': { target: API_TARGET, changeOrigin: true, ws: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // @laqum/shared's "exports" point at dist/, which only exists after a
      // build. Aliasing to source keeps `vite dev` working with no build step
      // and gives HMR on shared code.
      '@laqum/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    // 0.0.0.0, so a real tablet on the same network can reach it. That is the
    // only way to test the camera on the device it will actually run on.
    host: true,
    ...(hasCerts ? { https: { key: readFileSync(keyPath), cert: readFileSync(certPath) } } : {}),
    proxy: PROXY,
  },
  /*
   * `preview` serves the BUILT bundle and has its own proxy config — it does
   * NOT inherit `server.proxy`. The e2e suite runs against preview so it
   * exercises the production bundle, so the two have to be kept in step;
   * sharing one object is what keeps them so.
   */
  preview: {
    port: 4173,
    host: true,
    proxy: PROXY,
  },
});
