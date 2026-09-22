import type { Server as HttpServer } from 'node:http';
import type { Database } from '@laqum/db';
import {
  type Audience,
  type Clock,
  SUBSCRIBE_EVENT,
  SUBSCRIBED_EVENT,
  type SubscribedAck,
  publicRoom,
  staffRoom,
  subscribeSchema,
  userRoom,
} from '@laqum/shared';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { Server, type Socket } from 'socket.io';
import { currentLotVersion } from '../bookings/transition.js';
import type { Config } from '../config.js';
import { type Cancellable, type Timers, systemTimers } from './timers.js';
import { authoriseHandshake, expiryDelayMs, isLotStaff } from './authorise.js';

/**
 * The Socket.io server.
 *
 * Authorisation here is deliberately not "check once and trust the socket":
 * see realtime/authorise.ts for why a long-lived connection needs more than a
 * handshake. This file is the enforcement; that file is the reasoning.
 */

/** Sent immediately before a disconnect, so the client knows WHY. */
export const AUTH_EXPIRED_EVENT = 'auth.expired';
export const SUBSCRIBE_ERROR_EVENT = 'subscribe.error';

export interface SocketData {
  userId: string;
  role: string;
  expiresAt: Date;
  expiryTimer?: Cancellable;
}

export interface RealtimeDeps {
  db: Kysely<Database>;
  config: Config;
  clock: Clock;
  logger: Logger;
  timers?: Timers;
  /** Applied before any connection is accepted; used for the Redis adapter. */
  adapter?: Parameters<Server['adapter']>[0];
}

export interface RealtimeServer {
  io: Server;
  close(): Promise<void>;
}

export function createRealtimeServer(httpServer: HttpServer, deps: RealtimeDeps): RealtimeServer {
  const timers = deps.timers ?? systemTimers;
  const io = new Server(httpServer, {
    // The dashboard is served from a different origin in development (Vite on
    // 5173, API on 3000). Locked to the configured public origin rather than
    // '*', because these sockets carry plates.
    cors: { origin: corsOrigins(deps.config), credentials: true },
    // Nothing the client sends is large; a small cap limits what a hostile
    // client can make the server buffer.
    maxHttpBufferSize: 8_192,
    /*
     * Faster than the 25s/20s defaults, deliberately.
     *
     * The connection indicator's entire purpose is to tell an attendant
     * promptly that the grid has stopped updating. With the defaults a dead
     * connection can go unnoticed for ~45 seconds — long enough to turn a
     * driver away from a slot that is actually free. 10s/5s means the worst
     * case is ~15s, at the cost of one small frame each way per 10s per
     * socket, which for a handful of dashboards per lot is nothing.
     */
    pingInterval: 10_000,
    pingTimeout: 5_000,
  });

  if (deps.adapter) io.adapter(deps.adapter);

  /*
   * HANDSHAKE. A socket that fails here is never connected at all, so there is
   * no window in which an unauthenticated socket exists and could subscribe.
   */
  io.use((socket, next) => {
    void (async (): Promise<void> => {
      const result = await authoriseHandshake(
        deps.config,
        deps.clock,
        socket.handshake.auth['token'],
      );

      if (!result.ok) {
        // The reason is given to the client because it changes what the client
        // should do: refresh the token, or stop retrying.
        const err = new Error(result.reason);
        next(err);
        return;
      }

      const data = socket.data as SocketData;
      data.userId = result.principal.userId;
      data.role = result.principal.role;
      data.expiresAt = result.principal.expiresAt;
      next();
    })().catch((err: unknown) => {
      deps.logger.error({ err }, 'socket handshake failed unexpectedly');
      next(new Error('BAD_TOKEN'));
    });
  });

  io.on('connection', (socket) => {
    const data = socket.data as SocketData;

    /*
     * MECHANISM 1: the socket dies with its token.
     *
     * Armed from the token's own `exp`, so authority ends at exactly the
     * moment the credential does — not one refresh interval later, and not
     * whenever the client happens to reconnect.
     */
    const ttlMs = data.expiresAt.getTime() - deps.clock.now().getTime();
    data.expiryTimer = timers.after(expiryDelayMs(ttlMs), () => {
      // Told before being cut off: the client reconnects with a fresh token
      // rather than treating this as a network failure and backing off.
      socket.emit(AUTH_EXPIRED_EVENT, { reason: 'ACCESS_TOKEN_EXPIRED' });
      deps.logger.debug({ userId: data.userId }, 'disconnecting socket: token expired');
      socket.disconnect(true);
    });

    // A driver's own room needs no subscribe: it is theirs by identity, and
    // the id comes from the verified token rather than from the client.
    void socket.join(userRoom(data.userId));

    socket.on(SUBSCRIBE_EVENT, (payload: unknown, ack?: unknown) => {
      void handleSubscribe(deps, socket, payload, ack);
    });

    socket.on('disconnect', () => {
      data.expiryTimer?.cancel();
    });
  });

  return {
    io,
    close: async () => {
      await io.close();
    },
  };
}

function corsOrigins(config: Config): string[] {
  // Vite's dev server, plus wherever the app is actually served from.
  const origins = new Set([config.PUBLIC_BASE_URL]);
  if (config.NODE_ENV !== 'production') {
    origins.add('http://localhost:5173');
    origins.add('https://localhost:5173');
  }
  return [...origins];
}

type Ack = (response: { ok: true; data: SubscribedAck } | { ok: false; error: string }) => void;

async function handleSubscribe(
  deps: RealtimeDeps,
  socket: Socket,
  payload: unknown,
  rawAck: unknown,
): Promise<void> {
  const ack = typeof rawAck === 'function' ? (rawAck as Ack) : null;
  const data = socket.data as SocketData;

  const fail = (error: string): void => {
    if (ack) ack({ ok: false, error });
    else socket.emit(SUBSCRIBE_ERROR_EVENT, { error });
  };

  const parsed = subscribeSchema.safeParse(payload);
  if (!parsed.success) {
    fail('VALIDATION_ERROR');
    return;
  }
  const { lotId, audience } = parsed.data;

  /*
   * MECHANISM 2: membership is re-read on EVERY subscribe.
   *
   * Not cached at handshake, and not remembered from a previous subscribe on
   * this same socket. A reconnect is a fresh handshake plus a fresh subscribe,
   * so this also covers "including after reconnect" without a separate code
   * path — there is only one path, and it always asks the database.
   */
  if (audience === 'staff') {
    if (data.role !== 'attendant' && data.role !== 'operator_admin') {
      fail('FORBIDDEN');
      return;
    }
    const staffs = await isLotStaff(deps.db, data.userId, lotId);
    if (!staffs) {
      deps.logger.debug(
        { userId: data.userId, lotId },
        'refused staff subscribe: not assigned to this lot',
      );
      fail('FORBIDDEN');
      return;
    }
  }

  await joinExclusively(socket, lotId, audience);

  const lotVersion = await currentLotVersion(deps.db, lotId);
  const response: SubscribedAck = { lotId, audience, lotVersion };
  if (ack) ack({ ok: true, data: response });
  socket.emit(SUBSCRIBED_EVENT, response);
}

/**
 * Join the requested room and leave the other audience for that lot.
 *
 * Without the leave, a socket that subscribed as staff and then dropped to
 * public would still be in the staff room and would still receive plates. The
 * payload shape is bound to the room, so room membership IS the authorisation
 * — it has to be corrected, not merely added to.
 */
async function joinExclusively(socket: Socket, lotId: string, audience: Audience): Promise<void> {
  const wanted = audience === 'staff' ? staffRoom(lotId) : publicRoom(lotId);
  const other = audience === 'staff' ? publicRoom(lotId) : staffRoom(lotId);
  await socket.leave(other);
  await socket.join(wanted);
}
