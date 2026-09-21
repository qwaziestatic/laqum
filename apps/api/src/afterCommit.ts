import type { Database } from '@laqum/db';
import type { Kysely, Transaction } from 'kysely';
import type { Logger } from 'pino';

/**
 * INVARIANT 5: side effects happen after commit.
 *
 * Socket emits, push notifications and job scheduling must never run inside
 * the transaction that caused them. If they did, a rollback would leave a
 * scheduled job for a booking that does not exist, or a client told about a
 * state the database never reached.
 *
 * Work is registered during the transaction and executed only once the commit
 * has returned.
 */

export interface SideEffect {
  /** For logging, and for tests to assert on what was registered. */
  name: string;
  run: () => Promise<void>;
}

export class SideEffects {
  readonly #effects: SideEffect[] = [];

  add(name: string, run: () => Promise<void>): void {
    this.#effects.push({ name, run });
  }

  /** Names registered so far, in order. */
  get names(): string[] {
    return this.#effects.map((e) => e.name);
  }

  get size(): number {
    return this.#effects.length;
  }

  /**
   * Runs every effect, isolating failures.
   *
   * A failed side effect must not fail the request: the transaction has
   * already committed, so the booking is real whether or not a notification
   * went out. Effects are logged and swallowed, never rethrown.
   */
  async run(logger: Logger): Promise<void> {
    const effects = this.#effects.splice(0, this.#effects.length);
    for (const effect of effects) {
      try {
        await effect.run();
      } catch (err) {
        logger.error({ err, effect: effect.name }, 'after-commit side effect failed');
      }
    }
  }
}

/**
 * Run `fn` in a transaction, then run the side effects it registered.
 *
 * `effects.run` is unreachable if the transaction throws, so a rollback
 * cannot schedule anything. That is the whole point, and it is what
 * afterCommit.test.ts asserts.
 */
export async function inTransaction<T>(
  db: Kysely<Database>,
  logger: Logger,
  fn: (trx: Transaction<Database>, effects: SideEffects) => Promise<T>,
): Promise<T> {
  const effects = new SideEffects();
  const result = await db.transaction().execute((trx) => fn(trx, effects));
  await effects.run(logger);
  return result;
}
