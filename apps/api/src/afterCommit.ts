import type { Database } from '@laqum/db';
import type { Kysely, Transaction } from 'kysely';
import type { Logger } from 'pino';
import { type RealtimeEmitter, emitSlotChange, nullEmitter } from './realtime/emitter.js';

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
 * A slot whose state changed, and the lot version the change produced.
 *
 * `userId` is the driver to notify in their own room, null for a walk-in.
 */
export interface SlotChange {
  lotId: string;
  slotId: string;
  lotVersion: number;
  bookingId: string | null;
  userId: string | null;
}

/**
 * Changes recorded against an in-flight transaction.
 *
 * A WeakMap keyed by the Kysely Transaction, rather than a parameter threaded
 * through every caller. The reason is the whole design:
 *
 *   transition() is the ONE function that changes a booking's status
 *   (invariant 3), and create.ts the one that inserts one. If THEY record the
 *   change, then emitting is not something a write path can forget to do —
 *   there is no code path that changes a status without passing through a
 *   recorder. Threading an `effects` argument through nine call sites would
 *   put the guarantee back in the hands of whoever adds the tenth.
 *
 * It is a WeakMap so a transaction that is never drained (a rollback) is
 * collected with its entry, rather than leaking.
 */
const recorded = new WeakMap<object, SlotChange[]>();

export function recordSlotChange(trx: Transaction<Database>, change: SlotChange): void {
  const existing = recorded.get(trx);
  if (existing) existing.push(change);
  else recorded.set(trx, [change]);
}

/** Visible for tests: what has been recorded but not yet drained. */
export function recordedChanges(trx: Transaction<Database>): readonly SlotChange[] {
  return recorded.get(trx) ?? [];
}

export interface TxDeps {
  db: Kysely<Database>;
  logger: Logger;
  /** Omitted in tests that do not care; defaults to emitting nothing. */
  emitter?: RealtimeEmitter;
}

/**
 * Run `fn` in a transaction, then run the side effects it registered.
 *
 * `effects.run` is unreachable if the transaction throws, so a rollback
 * cannot schedule anything, and — because the recorded slot changes are
 * turned into effects only on the success path — a rollback emits nothing
 * either. That is the whole point, and it is what afterCommit.test.ts and
 * emit-coverage.test.ts assert.
 */
export async function inTransaction<T>(
  deps: TxDeps,
  fn: (trx: Transaction<Database>, effects: SideEffects) => Promise<T>,
): Promise<T> {
  const effects = new SideEffects();
  const emitter = deps.emitter ?? nullEmitter;
  let changes: readonly SlotChange[] = [];

  const result = await deps.db.transaction().execute(async (trx) => {
    const value = await fn(trx, effects);
    // Read INSIDE the transaction callback, so the changes collected belong to
    // this attempt. Deleted immediately: a retry gets a fresh transaction, and
    // a stale entry would emit a change twice.
    changes = recorded.get(trx) ?? [];
    recorded.delete(trx);
    return value;
  });

  for (const change of changes) {
    effects.add(`slot.updated:${change.slotId}@${String(change.lotVersion)}`, () =>
      emitSlotChange(deps.db, emitter, change),
    );
  }

  await effects.run(deps.logger);
  return result;
}
