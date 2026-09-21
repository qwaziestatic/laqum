import type { Redis } from 'ioredis';
import { type Kysely, sql } from 'kysely';

/**
 * Liveness vs readiness:
 *
 * /health answers "is this process alive?" It touches nothing external, so an
 * orchestrator never restarts a healthy API just because Postgres blipped.
 *
 * /ready answers "can this process serve traffic?" It checks Postgres and
 * Redis, so a rolling deploy does not send traffic to an instance that cannot
 * reach its dependencies.
 */

export type DependencyState = 'up' | 'down';

export interface DependencyResult {
  status: DependencyState;
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: Record<string, DependencyResult>;
}

/** A hung dependency must not hang the probe. */
const PROBE_TIMEOUT_MS = 2_000;

async function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`probe timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Turn a connection failure into something an operator can act on.
 *
 * A refused TCP connection reaches us as an AggregateError whose own `message`
 * is the empty string (Node tries every resolved address and collects the
 * failures), and pg puts the useful part in `code`. Reading `.message` alone
 * reports a dependency as "down" with no reason at all.
 */
export function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    const inner = err.errors.map(describeError).filter((m) => m.length > 0);
    return inner.length > 0 ? `${err.name}: ${inner.join('; ')}` : err.name;
  }
  if (err instanceof Error) {
    const base = err.message.length > 0 ? err.message : err.name;
    const code: unknown = (err as { code?: unknown }).code;
    return typeof code === 'string' && !base.includes(code) ? `${base} (${code})` : base;
  }
  return String(err);
}

async function probe(check: () => Promise<unknown>): Promise<DependencyResult> {
  const startedAt = performance.now();
  try {
    await withTimeout(check(), PROBE_TIMEOUT_MS);
    return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - startedAt),
      error: describeError(err),
    };
  }
}

export interface HealthDeps {
  db: Kysely<unknown>;
  redis: Redis;
}

export async function checkReadiness(deps: HealthDeps): Promise<ReadinessReport> {
  const [postgres, redis] = await Promise.all([
    probe(() => sql`SELECT 1`.execute(deps.db)),
    probe(() => deps.redis.ping()),
  ]);

  const checks = { postgres, redis };
  const ready = Object.values(checks).every((c) => c.status === 'up');
  return { status: ready ? 'ready' : 'not_ready', checks };
}
