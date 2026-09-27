import { createServer, type IncomingMessage, type Server } from 'node:http';
import { formatClock, informalAmharic, LOCALES } from '@laqum/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DEVICE_NOT_REGISTERED,
  ExpoPushProvider,
  PushUnavailableError,
  type PushMessage,
} from '../src/push/provider.js';
import { NOTIFICATION_KINDS, PUSH_TEXTS, pushText } from '../src/push/texts.js';
import { testLogger } from './helpers/db.js';
import { listenForFetch } from './helpers/listen.js';

/**
 * ExpoPushProvider against a local stand-in for Expo's push service, speaking
 * the documented shapes (docs.expo.dev, "Send notifications with Expo's push
 * service"): tickets in message order, receipts by ticket id.
 */

interface Seen {
  path: string;
  authorization: string | undefined;
  body: unknown;
}

let server: Server;
let base: string;
const seen: Seen[] = [];
let answer: (path: string, body: unknown) => { status: number; json: unknown };

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as unknown) : null;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void readJson(req).then((body) => {
      const path = req.url ?? '';
      if (req.method === 'POST') {
        seen.push({ path, authorization: req.headers.authorization, body });
      }
      const reply = req.method === 'POST' ? answer(path, body) : { status: 200, json: {} };
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.json));
    });
  });
  const port = await listenForFetch(server);
  base = `http://127.0.0.1:${String(port)}/--/api/v2/push`;
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  seen.length = 0;
});

function message(i: number): PushMessage {
  return {
    to: `ExponentPushToken[t${String(i)}]`,
    title: 'T',
    body: 'B',
    data: { bookingId: 'b' },
  };
}

describe('ExpoPushProvider', () => {
  it('sends in chunks of 100 and returns one ticket per message, in order', async () => {
    answer = (_path, body) => ({
      status: 200,
      json: {
        data: (body as PushMessage[]).map((m) =>
          m.to.endsWith('[t3]')
            ? { status: 'error', message: 'gone', details: { error: DEVICE_NOT_REGISTERED } }
            : { status: 'ok', id: `id-${m.to}` },
        ),
      },
    });
    const provider = new ExpoPushProvider({ logger: testLogger(), baseUrl: base });

    const tickets = await provider.send(Array.from({ length: 150 }, (_, i) => message(i)));

    expect(seen.map((s) => [s.path, (s.body as unknown[]).length])).toEqual([
      ['/--/api/v2/push/send', 100],
      ['/--/api/v2/push/send', 50],
    ]);
    expect(tickets).toHaveLength(150);
    expect(tickets[0]).toEqual({ status: 'ok', id: 'id-ExponentPushToken[t0]' });
    expect(tickets[3]).toEqual({ status: 'error', message: 'gone', error: DEVICE_NOT_REGISTERED });
    expect(tickets[149]).toEqual({ status: 'ok', id: 'id-ExponentPushToken[t149]' });
  });

  it('sends the access token only when there is one', async () => {
    answer = () => ({ status: 200, json: { data: [{ status: 'ok', id: 'x' }] } });
    await new ExpoPushProvider({ logger: testLogger(), baseUrl: base }).send([message(0)]);
    await new ExpoPushProvider({ logger: testLogger(), baseUrl: base, accessToken: 'secret' }).send(
      [message(0)],
    );
    expect(seen.map((s) => s.authorization)).toEqual([undefined, 'Bearer secret']);
  });

  it('reads receipts by ticket id', async () => {
    answer = () => ({
      status: 200,
      json: {
        data: {
          a: { status: 'ok' },
          b: { status: 'error', message: 'gone', details: { error: DEVICE_NOT_REGISTERED } },
        },
      },
    });
    const receipts = await new ExpoPushProvider({ logger: testLogger(), baseUrl: base }).receipts([
      'a',
      'b',
    ]);
    expect(seen[0]).toMatchObject({
      path: '/--/api/v2/push/getReceipts',
      body: { ids: ['a', 'b'] },
    });
    expect(receipts).toEqual({
      a: { status: 'ok' },
      b: { status: 'error', message: 'gone', error: DEVICE_NOT_REGISTERED },
    });
  });

  it('an error answer is PushUnavailableError, so the job is retried', async () => {
    answer = () => ({ status: 503, json: {} });
    await expect(
      new ExpoPushProvider({ logger: testLogger(), baseUrl: base }).send([message(0)]),
    ).rejects.toBeInstanceOf(PushUnavailableError);
  });
});

describe('the notification texts', () => {
  const placeholders = (text: string): string[] =>
    [...text.matchAll(/\{\{(\w+)\}\}/gu)].map((m) => m[1] ?? '').sort();

  it('say the same things in both languages', () => {
    for (const kind of NOTIFICATION_KINDS) {
      for (const part of ['title', 'body'] as const) {
        const [am, en] = LOCALES.map((locale) => placeholders(PUSH_TEXTS[locale][kind][part]));
        expect(am, `${kind}.${part}`).toEqual(en);
      }
    }
  });

  it('are polite in Amharic', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const { title, body } = PUSH_TEXTS.am[kind];
      expect(informalAmharic(`${title} ${body}`), kind).toEqual([]);
    }
  });

  it('fill every placeholder, with the Ethiopian clock in Amharic', () => {
    const time = new Date('2026-03-01T11:05:00.000Z'); // 14:05 in Addis Ababa
    const values = { lot: 'Bole Lot', time, minutes: 5, amountSantim: 4500 };
    for (const locale of LOCALES) {
      for (const kind of NOTIFICATION_KINDS) {
        const { title, body } = pushText(kind, locale, values);
        expect(`${title} ${body}`, `${locale} ${kind}`).not.toMatch(/\{\{|\}\}/u);
      }
    }
    expect(pushText('hold-reminder', 'am', values).body).toContain(formatClock(time, 'am'));
    expect(formatClock(time, 'am')).toBe('ከሰዓት 8:05');
    expect(pushText('hold-reminder', 'en', values).body).toContain('14:05');
    expect(pushText('amount-due', 'en', values).title).toBe('Payment due: 45.00 ETB');
  });
});
