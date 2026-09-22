/**
 * Timer injection, for the same reason the Clock is injected.
 *
 * The token-expiry disconnect is the one piece of realtime behaviour that
 * happens at a wall-clock moment nobody triggers. Testing it against the real
 * setTimeout would mean either a real sleep of minutes or a token contrived to
 * expire in milliseconds — the first is unacceptable in a suite, the second
 * tests a timing accident rather than the rule.
 *
 * So the schedule is an interface, and the test drives it directly.
 */

export interface Cancellable {
  cancel(): void;
}

export interface Timers {
  after(ms: number, fn: () => void): Cancellable;
}

export const systemTimers: Timers = {
  after(ms, fn) {
    const handle = setTimeout(fn, ms);
    // Never hold the process open: a socket waiting to be disconnected must
    // not be the reason a shutdown hangs.
    handle.unref();
    return {
      cancel: () => {
        clearTimeout(handle);
      },
    };
  },
};

/** A Timers whose callbacks fire only when the test says so. */
export class ManualTimers implements Timers {
  private pending = new Map<number, { dueAt: number; fn: () => void }>();
  private nextId = 1;
  private elapsed = 0;

  after(ms: number, fn: () => void): Cancellable {
    const id = this.nextId++;
    this.pending.set(id, { dueAt: this.elapsed + ms, fn });
    return {
      cancel: () => {
        this.pending.delete(id);
      },
    };
  }

  /** Run everything due within `ms` from now, in due order. */
  advance(ms: number): void {
    this.elapsed += ms;
    const due = [...this.pending.entries()]
      .filter(([, t]) => t.dueAt <= this.elapsed)
      .sort((a, b) => a[1].dueAt - b[1].dueAt);
    for (const [id, timer] of due) {
      this.pending.delete(id);
      timer.fn();
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
