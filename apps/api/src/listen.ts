import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Binds `server` to `port`, resolving with the address it ACTUALLY bound.
 *
 * Never Express 5's `app.listen(port, callback)`. It registers the callback
 * as the server's one-shot 'error' listener as well
 * (express/lib/application.js), so a failed bind CALLS THE "LISTENING"
 * CALLBACK with the error as its first argument — and since the 'error' event
 * now has a listener, Node does not throw either. On a Windows machine whose
 * Hyper-V/WinNAT reserved ranges had come to cover :3000, that logged
 * "API listening" over a process bound to nothing, kept alive indefinitely
 * by its Redis and BullMQ connections. guards.test.ts forbids it.
 *
 * Here success is the 'listening' event and nothing else, and a failure
 * rejects with a ListenError whose message says what to do about it.
 */
export function listen(server: Server, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(new ListenError(port, err));
    };
    const onListening = (): void => {
      // From here on a server error has no listener and crashes the process,
      // which is the right outcome for a socket that fails after binding.
      server.off('error', onError);
      const address = server.address();
      // Only a pipe (a string) or a closed server (null) gives anything else.
      if (address === null || typeof address === 'string') {
        reject(new ListenError(port, new Error(`bound to unexpected address ${String(address)}`)));
        return;
      }
      resolve(address);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

/** A bind that failed, with a message an operator can act on. */
export class ListenError extends Error {
  readonly port: number;
  readonly code: string | undefined;

  constructor(port: number, cause: NodeJS.ErrnoException) {
    super(describeListenFailure(port, cause), { cause });
    this.name = 'ListenError';
    this.port = port;
    this.code = cause.code;
  }
}

function describeListenFailure(port: number, err: NodeJS.ErrnoException): string {
  const head = `Cannot listen on port ${String(port)}`;
  switch (err.code) {
    case 'EADDRINUSE':
      return `${head}: another process is already using it (EADDRINUSE). Stop that process, or set PORT to a free port.`;
    case 'EACCES':
      return (
        `${head}: the operating system refused it (EACCES). On Windows this usually means the ` +
        'port is inside a range reserved by Hyper-V/WinNAT; list them with ' +
        '`netsh interface ipv4 show excludedportrange protocol=tcp`. On Linux, ports below 1024 ' +
        'need privileges. Set PORT to a port outside those ranges.'
      );
    default:
      return `${head}: ${err.code ?? 'error'}: ${err.message}`;
  }
}
