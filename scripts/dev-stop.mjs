#!/usr/bin/env node
/**
 * Stop whatever holds the dev ports.
 *
 *   pnpm dev:stop                   18000 (API), 18081 (Metro), 5173 and 5174 (dashboard)
 *   pnpm dev:stop -- 3000 5673      other ports instead
 *   pnpm dev:stop -- --dry-run      only say what holds them
 *
 * WHY. On Windows, Ctrl+C in Git Bash can leave node running (pnpm, tsx watch
 * and the server are three processes, and the signal does not always reach
 * the last one). The next start then fails with EADDRINUSE, which reads like
 * a code problem.
 *
 * HOW. Windows: `netstat -ano`, then `taskkill /T /F` (the tree: tsx watch
 * keeps a child). Linux: `ss -ltnpH`, then SIGTERM, then SIGKILL after 3 s.
 * Never stops PID 0 or 4 (Windows' System), nor itself. Whatever holds a
 * listed port is stopped, whatever it is, and named first.
 */
import { execFileSync } from 'node:child_process';

export const DEV_PORTS = [18000, 18081, 5173, 5174];

/** Windows' own processes, and this script. */
export function mayStop(pid, self = process.pid) {
  return Number.isInteger(pid) && pid > 4 && pid !== self;
}

function portOf(address) {
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  return Number.isInteger(port) ? port : null;
}

/** `netstat -ano` (Windows): the listeners on `ports`, IPv4 and IPv6. */
export function parseNetstat(output, ports) {
  const found = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/iu.exec(line);
    if (!match) continue;
    const port = portOf(match[1]);
    if (port !== null && ports.includes(port)) found.push({ port, pid: Number(match[2]) });
  }
  return dedupe(found);
}

/** `ss -ltnpH` (Linux): the listeners on `ports`, with their process names. */
export function parseSs(output, ports) {
  const found = [];
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 5) continue;
    const port = portOf(fields[3]);
    if (port === null || !ports.includes(port)) continue;
    for (const match of line.matchAll(/\("([^"]*)",pid=(\d+)/gu)) {
      found.push({ port, pid: Number(match[2]), name: match[1] });
    }
  }
  return dedupe(found);
}

function dedupe(listeners) {
  const seen = new Set();
  return listeners.filter(({ port, pid }) => {
    const key = `${String(port)}:${String(pid)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function listeners(ports) {
  if (process.platform === 'win32') return parseNetstat(run('netstat', ['-ano']), ports);
  return parseSs(run('ss', ['-ltnpH']), ports);
}

function nameOf(listener) {
  if (listener.name) return listener.name;
  if (process.platform !== 'win32') return 'unknown';
  try {
    const row = run('tasklist', ['/FI', `PID eq ${String(listener.pid)}`, '/FO', 'CSV', '/NH']);
    return /^"([^"]+)"/u.exec(row.trim())?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stop(pid) {
  if (process.platform === 'win32') {
    try {
      run('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch {
      // Already gone, or refused: checked below.
    }
    return !alive(pid);
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !alive(pid);
  }
  for (let waited = 0; waited < 3000 && alive(pid); waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone between the check and the kill.
    }
  }
  return !alive(pid);
}

export async function devStop(ports, { dryRun = false, log = console.log } = {}) {
  const held = listeners(ports);
  let failed = 0;

  for (const port of ports) {
    const holders = held.filter((listener) => listener.port === port);
    if (holders.length === 0) {
      log(`${String(port).padStart(5)}  free`);
      continue;
    }
    for (const holder of holders) {
      const who = `${nameOf(holder)} (pid ${String(holder.pid)})`;
      if (!mayStop(holder.pid)) {
        log(`${String(port).padStart(5)}  ${who}: not stopped (a system process)`);
        continue;
      }
      if (dryRun) {
        log(`${String(port).padStart(5)}  ${who}: would stop`);
        continue;
      }
      const stopped = await stop(holder.pid);
      if (!stopped) failed++;
      log(`${String(port).padStart(5)}  ${who}: ${stopped ? 'stopped' : 'STILL RUNNING'}`);
    }
  }
  return failed;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const ports = args.filter((arg) => /^\d+$/u.test(arg)).map(Number);
  const failed = await devStop(ports.length > 0 ? ports : DEV_PORTS, {
    dryRun: args.includes('--dry-run'),
  });
  process.exitCode = failed > 0 ? 1 : 0;
}
