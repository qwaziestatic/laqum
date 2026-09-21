import type { Logger } from 'pino';

/**
 * SMS is behind an interface so a real provider can be dropped in without
 * touching the OTP flow. Only the console provider exists for now, per the
 * brief.
 */
export interface SmsProvider {
  readonly name: string;
  send(to: string, message: string): Promise<void>;
}

/** Logs the message instead of sending it. Development and tests only. */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  send(to: string, message: string): Promise<void> {
    // warn, not info: this prints a live credential and should be
    // uncomfortable to see in a log.
    this.#logger.warn({ to, message }, 'ConsoleSmsProvider: SMS not actually sent');
    return Promise.resolve();
  }
}

/** Records messages so tests can read the code without parsing logs. */
export class RecordingSmsProvider implements SmsProvider {
  readonly name = 'recording';
  readonly sent: { to: string; message: string }[] = [];

  send(to: string, message: string): Promise<void> {
    this.sent.push({ to, message });
    return Promise.resolve();
  }

  lastMessageTo(to: string): string | undefined {
    return this.sent.filter((m) => m.to === to).at(-1)?.message;
  }

  reset(): void {
    this.sent.length = 0;
  }
}
