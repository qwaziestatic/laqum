import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mayStop, parseNetstat, parseSs } from '../../../scripts/dev-stop.mjs';

/**
 * `pnpm dev:stop`: stops whatever holds the dev ports. On Windows, Ctrl+C in
 * Git Bash can leave node running, and the next start fails EADDRINUSE.
 */

const SCRIPT = fileURLToPath(new URL('../../../scripts/dev-stop.mjs', import.meta.url));

describe('reading who holds a port', () => {
  it('Windows netstat: IPv4 and IPv6 listeners, nothing else', () => {
    const output = [
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:18000          0.0.0.0:0              LISTENING       4120',
      '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
      '  TCP    127.0.0.1:5173         127.0.0.1:61234        ESTABLISHED     6000',
      '  TCP    [::]:18000             [::]:0                 LISTENING       4120',
      '  TCP    [::1]:5173             [::]:0                 LISTENING       7312',
      '  UDP    0.0.0.0:18081          *:*                                    900',
    ].join('\r\n');

    expect(parseNetstat(output, [18000, 18081, 5173])).toEqual([
      { port: 18000, pid: 4120 },
      { port: 5173, pid: 7312 },
    ]);
  });

  it('Linux ss: listeners with their process names, several per port', () => {
    const output = [
      'LISTEN 0      511          0.0.0.0:18000      0.0.0.0:*    users:(("node",pid=2211,fd=21))',
      'LISTEN 0      511                *:18081            *:*    users:(("node",pid=3300,fd=19),("node",pid=3301,fd=19))',
      'LISTEN 0      4096       127.0.0.1:5432       0.0.0.0:*',
    ].join('\n');

    expect(parseSs(output, [18000, 18081, 5173])).toEqual([
      { port: 18000, pid: 2211, name: 'node' },
      { port: 18081, pid: 3300, name: 'node' },
      { port: 18081, pid: 3301, name: 'node' },
    ]);
  });

  it("never stops Windows' System processes, or itself", () => {
    expect(mayStop(0)).toBe(false);
    expect(mayStop(4)).toBe(false);
    expect(mayStop(1234, 1234)).toBe(false);
    expect(mayStop(4120, 1234)).toBe(true);
  });
});

describe('stopping a real listener', () => {
  let child: ChildProcess | null = null;

  afterEach(() => {
    child?.kill();
    child = null;
  });

  /** A node process holding a port, like a stale API: its port once listening. */
  function listener(): Promise<number> {
    child = spawn(
      process.execPath,
      [
        '-e',
        "const s=require('http').createServer();s.listen(0,()=>console.log(s.address().port));setInterval(()=>{},1000);",
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    return new Promise((resolve) => {
      child?.stdout?.once('data', (chunk: Buffer) => {
        resolve(Number(String(chunk).trim()));
      });
    });
  }

  function devStop(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [SCRIPT, ...args], (err, stdout) => {
        if (err) reject(new Error(`dev:stop failed: ${err.message}`));
        else resolve(stdout);
      });
    });
  }

  function exited(): Promise<void> {
    return new Promise((resolve) => {
      // Already gone (or never started): nothing to wait for.
      if (child?.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => {
        resolve();
      });
    });
  }

  it('only names it on a dry run', async () => {
    const port = await listener();
    const out = await devStop(String(port), '--dry-run');
    expect(out).toMatch(
      new RegExp(`${String(port)}\\s+\\S+ \\(pid ${String(child?.pid)}\\): would stop`, 'u'),
    );
    expect(child?.exitCode).toBeNull();
  }, 20_000);

  it('stops it, and says so', async () => {
    const port = await listener();
    const out = await devStop(String(port));
    expect(out).toMatch(
      new RegExp(`${String(port)}\\s+\\S+ \\(pid ${String(child?.pid)}\\): stopped`, 'u'),
    );
    await exited();
  }, 20_000);

  it('reports a free port as free', async () => {
    const port = await listener();
    child?.kill();
    await exited();
    expect(await devStop(String(port))).toMatch(new RegExp(`${String(port)}\\s+free`, 'u'));
  }, 20_000);
});
