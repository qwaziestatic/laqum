import type { Logger } from 'pino';

/**
 * PUSH DELIVERY, behind an interface like SMS and payments.
 *
 * ExpoPushProvider speaks Expo's push service
 * (https://docs.expo.dev/push-notifications/sending-notifications/): up to 100
 * messages per request, one ticket per message IN ORDER, receipts fetched
 * later by ticket id. Expo relays to FCM with the project's FCM V1 key, held
 * by EAS (docs/DEPLOY.md, "Push"). Plain fetch, no SDK: at this scale the
 * SDK's throttling is not needed, and it would add a second HTTP client.
 *
 * What crosses the border (Expo is in the US, FCM is Google's) is kept to a
 * sentence, a lot name, a time or an amount, and a booking id: never a
 * phone number or a plate (Proclamation 1321/2024, Art. 20).
 */

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Opaque ids only: the app opens the booking from it. */
  data: Record<string, string>;
}

export type PushTicket =
  { status: 'ok'; id: string } | { status: 'error'; message: string; error?: string | undefined };

export type PushReceipt =
  { status: 'ok' } | { status: 'error'; message: string; error?: string | undefined };

export interface PushProvider {
  readonly name: string;
  /** One ticket per message, in the same order. */
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  receipts(ids: string[]): Promise<Record<string, PushReceipt>>;
}

/** The error Expo reports for a token that can no longer be delivered to. */
export const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

export class PushUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushUnavailableError';
  }
}

const SEND_CHUNK = 100;
const RECEIPTS_CHUNK = 1000;

interface ExpoTicketWire {
  status?: unknown;
  id?: unknown;
  message?: unknown;
  details?: { error?: unknown };
}

function toTicket(wire: ExpoTicketWire): PushTicket {
  if (wire.status === 'ok' && typeof wire.id === 'string') return { status: 'ok', id: wire.id };
  return {
    status: 'error',
    message: typeof wire.message === 'string' ? wire.message : 'unknown push error',
    error: typeof wire.details?.error === 'string' ? wire.details.error : undefined,
  };
}

export class ExpoPushProvider implements PushProvider {
  readonly name = 'expo';
  readonly #base: string;
  readonly #accessToken: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #logger: Logger;

  constructor(options: {
    logger: Logger;
    /** Required once "enhanced push security" is on for the project. */
    accessToken?: string | undefined;
    baseUrl?: string;
    fetch?: typeof fetch;
  }) {
    this.#base = (options.baseUrl ?? 'https://exp.host/--/api/v2/push').replace(/\/+$/u, '');
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#logger = options.logger;
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          ...(this.#accessToken ? { Authorization: `Bearer ${this.#accessToken}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new PushUnavailableError(`Expo push unreachable: ${String(err)}`);
    }
    if (!res.ok) {
      throw new PushUnavailableError(`Expo push answered ${String(res.status)}`);
    }
    return await res.json();
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += SEND_CHUNK) {
      const chunk = messages.slice(i, i + SEND_CHUNK).map((m) => ({
        ...m,
        sound: 'default',
        priority: 'high',
      }));
      const reply = (await this.#post('/send', chunk)) as { data?: unknown };
      const data = Array.isArray(reply.data) ? (reply.data as ExpoTicketWire[]) : [];
      if (data.length !== chunk.length) {
        this.#logger.error(
          { sent: chunk.length, tickets: data.length },
          'Expo push returned a different number of tickets than messages',
        );
      }
      for (let j = 0; j < chunk.length; j++) {
        const wire = data[j];
        tickets.push(wire ? toTicket(wire) : { status: 'error', message: 'no ticket returned' });
      }
    }
    return tickets;
  }

  async receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    const out: Record<string, PushReceipt> = {};
    for (let i = 0; i < ids.length; i += RECEIPTS_CHUNK) {
      const reply = (await this.#post('/getReceipts', {
        ids: ids.slice(i, i + RECEIPTS_CHUNK),
      })) as {
        data?: Record<string, ExpoTicketWire>;
      };
      for (const [id, wire] of Object.entries(reply.data ?? {})) {
        out[id] =
          wire.status === 'ok'
            ? { status: 'ok' }
            : {
                status: 'error',
                message: typeof wire.message === 'string' ? wire.message : 'unknown push error',
                error: typeof wire.details?.error === 'string' ? wire.details.error : undefined,
              };
      }
    }
    return out;
  }
}

/** Records what would have been sent; tickets and receipts can be scripted. */
export class FakePushProvider implements PushProvider {
  readonly name = 'fake';
  readonly sent: PushMessage[] = [];
  /** Tokens Expo would report as no longer registered, at send time. */
  readonly unregistered = new Set<string>();
  /** Receipts to report later, by ticket id. */
  readonly scriptedReceipts = new Map<string, PushReceipt>();
  #ticket = 0;

  send(messages: PushMessage[]): Promise<PushTicket[]> {
    this.sent.push(...messages);
    return Promise.resolve(
      messages.map((m) =>
        this.unregistered.has(m.to)
          ? { status: 'error', message: 'not registered', error: DEVICE_NOT_REGISTERED }
          : { status: 'ok', id: `ticket-${String((this.#ticket += 1))}` },
      ),
    );
  }

  receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    return Promise.resolve(
      Object.fromEntries(ids.map((id) => [id, this.scriptedReceipts.get(id) ?? { status: 'ok' }])),
    );
  }

  reset(): void {
    this.sent.length = 0;
    this.unregistered.clear();
    this.scriptedReceipts.clear();
  }
}
