import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ListenError, listen } from '../src/listen.js';

/**
 * listen() is the only way the API binds a port (guards.test.ts). These pin
 * the two properties Express 5's app.listen(port, callback) lacks: success
 * means the port is really bound, and a failed bind is an error, never a
 * callback that reads as success.
 */

const open: Server[] = [];

function track(server: Server): Server {
  open.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

describe('listen()', () => {
  it('resolves with the address the operating system actually bound', async () => {
    const server = track(createServer());

    const bound = await listen(server, 0);

    expect(server.listening).toBe(true);
    expect(bound.port).toBeGreaterThan(0);
    expect(bound).toEqual(server.address() as AddressInfo);
  });

  it('rejects a port that is already taken, and says so', async () => {
    const blocker = track(createServer());
    const { port } = await listen(blocker, 0);
    const server = track(createServer());

    const failure = await failureOf(listen(server, port));

    expect(failure).toBeInstanceOf(ListenError);
    const error = failure as ListenError;
    expect(error.code).toBe('EADDRINUSE');
    expect(error.port).toBe(port);
    expect(error.message).toBe(
      `Cannot listen on port ${String(port)}: another process is already using it ` +
        '(EADDRINUSE). Stop that process, or set PORT to a free port.',
    );
    expect(server.listening).toBe(false);
  });

  it('leaves no error listener behind after a successful bind', async () => {
    // So an error AFTER binding is unhandled and crashes the process, rather
    // than being routed into a promise that has already settled.
    // Compared with the counts beforehand: http.Server registers a
    // 'listening' listener of its own (connection tracking).
    const server = track(createServer());
    const errorsBefore = server.listenerCount('error');
    const listeningBefore = server.listenerCount('listening');

    await listen(server, 0);

    expect(server.listenerCount('error')).toBe(errorsBefore);
    expect(server.listenerCount('listening')).toBe(listeningBefore);
  });

  it('explains EACCES as a reserved or privileged port', () => {
    // EACCES cannot be produced portably: which ports Windows reserves moves
    // on every boot, and CI may run as root. The message is what matters.
    const cause = Object.assign(new Error('listen EACCES: permission denied 0.0.0.0:3000'), {
      code: 'EACCES',
    });

    const error = new ListenError(3000, cause);

    expect(error.code).toBe('EACCES');
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('Cannot listen on port 3000');
    expect(error.message).toContain('netsh interface ipv4 show excludedportrange protocol=tcp');
    expect(error.message).toContain('Set PORT');
  });
});
