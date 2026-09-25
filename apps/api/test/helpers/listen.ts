import type { Server } from 'node:http';
import { listen } from '../../src/listen.js';

/**
 * Port 0, but a port FETCH WILL USE.
 *
 * The Fetch standard blocks a list of "bad ports" (6665-6669, 6679, 6697,
 * 10080 and more), and Node's fetch enforces it before connecting: "fetch
 * failed", cause "bad port". On the dev machine the TCP dynamic range starts
 * at 1024 (CLAUDE.md, Phase 3 facts), so port 0 can hand out one of them.
 * The driver realtime test failed that way once in about five runs on port
 * 6679, and any test that fetches from a port-0 server could.
 *
 * Probed with the real fetch rather than a copied list: Node keeps its list
 * internal, and a copy would drift.
 */

export function isBadPortError(err: unknown): boolean {
  return err instanceof TypeError && err.cause instanceof Error && err.cause.message === 'bad port';
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** Resolves with a port the server listens on and fetch accepts. Probes GET /health. */
export async function listenForFetch(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { port } = await listen(server, 0);
    try {
      const probe = await fetch(`http://127.0.0.1:${String(port)}/health`);
      await probe.arrayBuffer();
      return port;
    } catch (err) {
      if (!isBadPortError(err)) throw err;
      await close(server);
    }
  }
  throw new Error('no port fetch would use after 10 attempts');
}
