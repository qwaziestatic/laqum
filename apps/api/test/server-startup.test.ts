import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { listen } from '../src/listen.js';
import { TEST_REDIS_URL } from './helpers/context.js';
import { TEST_DATABASE_URL } from './helpers/db.js';

/**
 * The REAL entry point, as a child process.
 *
 * "A bind failure crashes the process" is a property of the process, not of
 * any function: the original bug was a process that logged "API listening",
 * bound nothing, and stayed alive on its Redis and BullMQ connections. Only
 * running src/server.ts itself can show that it now exits instead.
 *
 * It runs the way `pnpm dev` does (tsx, `development` condition) against the
 * test Postgres and Redis. RUN_WORKER=false keeps it from consuming jobs that
 * belong to other test files.
 */

const API_ROOT = fileURLToPath(new URL('..', import.meta.url));
const STARTUP_TIMEOUT_MS = 30_000;

const children: ChildProcess[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

function startApi(port: number): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--conditions=development', '--import', 'tsx', 'src/server.ts'],
    {
      cwd: API_ROOT,
      env: {
        // Inherited for PATH and, on Windows, SystemRoot, without which
        // sockets cannot be created at all. Then everything the config
        // validates is pinned, so a developer's shell cannot change the run.
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        PORT: String(port),
        DATABASE_URL: TEST_DATABASE_URL,
        REDIS_URL: TEST_REDIS_URL,
        RUN_WORKER: 'false',
        PAYMENT_PROVIDER: 'fake',
        DEV_AUTH: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  return child;
}

interface Output {
  stdout: string;
  stderr: string;
}

function capture(child: ChildProcess): Output {
  const output: Output = { stdout: '', stderr: '' };
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    output.stderr += chunk;
  });
  return output;
}

/** Resolves with the exit code, or rejects if the process outlives the timeout. */
function exitOf(child: ChildProcess, output: Output): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `still running after ${String(STARTUP_TIMEOUT_MS)} ms — a bind failure was swallowed.\n` +
            `stdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    }, STARTUP_TIMEOUT_MS);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Resolves with the first complete stdout line matching `pattern`. */
function lineMatching(child: ChildProcess, output: Output, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `no line matching ${String(pattern)} within ${String(STARTUP_TIMEOUT_MS)} ms.\n` +
            `stdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    }, STARTUP_TIMEOUT_MS);
    const check = (): void => {
      const line = output.stdout.split('\n').find((l) => pattern.test(l));
      if (line === undefined) return;
      clearTimeout(timer);
      child.stdout?.off('data', check);
      resolve(line);
    };
    child.stdout?.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `exited with ${String(code)} before logging ${String(pattern)}.\n` +
            `stdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    });
  });
}

async function occupiedPort(): Promise<number> {
  const blocker = createServer();
  servers.push(blocker);
  return (await listen(blocker, 0)).port;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  const { port } = await listen(probe, 0);
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
}

describe('API process startup', () => {
  it(
    'exits non-zero with a clear message when it cannot bind, and never claims to be listening',
    async () => {
      const port = await occupiedPort();
      const child = startApi(port);
      const output = capture(child);

      const code = await exitOf(child, output);

      expect(code).toBe(1);
      expect(output.stderr).toContain(
        `ላቁም? API failed to start: Cannot listen on port ${String(port)}: ` +
          'another process is already using it (EADDRINUSE)',
      );
      expect(output.stdout).not.toContain('API listening');
    },
    STARTUP_TIMEOUT_MS + 5_000,
  );

  it(
    'logs "API listening" with the address it actually bound, and really is listening',
    async () => {
      const port = await freePort();
      const child = startApi(port);
      const output = capture(child);

      const line = await lineMatching(child, output, /API listening/u);
      const entry = JSON.parse(line) as Record<string, unknown>;

      expect(entry['port']).toBe(port);
      expect(entry['address']).toEqual(expect.any(String));
      expect(entry['family']).toMatch(/^IPv[46]$/u);
      // The log is only worth something if it is true.
      const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(res.status).toBe(200);
    },
    STARTUP_TIMEOUT_MS + 5_000,
  );
});
