import { type BookingUpdated, bookingUpdatedSchema } from '@laqum/shared';
import type { ManagerOptions, Socket, SocketOptions } from 'socket.io-client';

/**
 * The driver's socket: their own booking's changes, pushed.
 *
 * The API puts every driver's socket in `user:{id}` at connection, from the
 * verified token, and emits `booking.updated` there after every commit that
 * moves one of their bookings. Nothing is subscribed to: the room is theirs by
 * identity.
 *
 * REALTIME IS A NOTIFICATION CHANNEL (invariant 7). On every connect,
 * including reconnects, listeners are told to RESYNC: refetch the booking,
 * whose response carries the lot version it was read at, and apply only
 * events newer than that (bookingFeed.ts). The socket is joined before the
 * snapshot is requested, so a change in between arrives twice, never zero
 * times. While the socket is down the booking screen polls instead.
 *
 * THE TOKEN. The server refuses a handshake with an expired token and cuts a
 * live socket off when its token expires (after sending `auth.expired`). In
 * both cases socket.io does not retry by itself, so this refreshes the
 * session, through the ApiClient's single-flight refresh, and reconnects. The
 * handshake reads the token through a callback, so every attempt carries the
 * current one.
 */

export const BOOKING_UPDATED_EVENT = 'booking.updated';
export const AUTH_EXPIRED_EVENT = 'auth.expired';

/** Handshake refusals that mean "your token", not "the network". */
const AUTH_REFUSALS: ReadonlySet<string> = new Set(['NO_TOKEN', 'BAD_TOKEN', 'EXPIRED']);

export type RealtimeState = 'connecting' | 'live' | 'reconnecting' | 'offline';

type IoOptions = Partial<ManagerOptions & SocketOptions>;

export interface DriverRealtimeDeps {
  /** The API's origin, e.g. http://192.168.1.20:18000 (see socketOriginFor). */
  url: string;
  /** socket.io-client's `io`. Injected so the API's tests can pass their own copy. */
  io: (url: string, options: IoOptions) => Socket;
  /** The current access token, read at every connection attempt. */
  token: () => string | null;
  /** Refresh the session; true when a fresh token is available. */
  refresh: () => Promise<boolean>;
}

/** The socket lives at the API's origin; the REST base URL ends in /v1. */
export function socketOriginFor(apiUrl: string): string {
  return apiUrl.replace(/\/v1\/?$/u, '').replace(/\/$/u, '');
}

type Listener<T> = (value: T) => void;

export class DriverRealtime {
  readonly #deps: DriverRealtimeDeps;
  #socket: Socket | null = null;
  #state: RealtimeState = 'offline';
  #closed = true;
  #reauthenticating: Promise<void> | null = null;
  readonly #bookingListeners = new Set<Listener<BookingUpdated>>();
  readonly #resyncListeners = new Set<Listener<undefined>>();
  readonly #stateListeners = new Set<Listener<RealtimeState>>();

  constructor(deps: DriverRealtimeDeps) {
    this.#deps = deps;
  }

  get state(): RealtimeState {
    return this.#state;
  }

  /** Read through a method after an await: close() can run meanwhile. */
  #isClosed(): boolean {
    return this.#closed;
  }

  start(): void {
    if (this.#socket) return;
    this.#closed = false;
    this.#setState('connecting');

    const socket = this.#deps.io(this.#deps.url, {
      // A callback, so a reconnect after a refresh carries the new token.
      // In the handshake payload, never the URL, where proxies log it.
      auth: (cb) => {
        cb({ token: this.#deps.token() ?? '' });
      },
      // React Native has WebSocket; long-polling would only add a second
      // path to go wrong on a phone.
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
    });
    this.#socket = socket;

    socket.on('connect', () => {
      this.#setState('live');
      for (const listener of this.#resyncListeners) listener(undefined);
    });

    socket.on(BOOKING_UPDATED_EVENT, (payload: unknown) => {
      const parsed = bookingUpdatedSchema.safeParse(payload);
      // Not understood: the resync on the next connect is the backstop.
      if (!parsed.success) return;
      for (const listener of this.#bookingListeners) listener(parsed.data);
    });

    socket.on(AUTH_EXPIRED_EVENT, () => {
      void this.#reauthenticate();
    });

    socket.on('disconnect', (reason) => {
      if (this.#isClosed()) return;
      this.#setState('reconnecting');
      // The server closed us on purpose (token expiry); socket.io will not
      // retry that by itself. Other reasons it retries on its own.
      if (reason === 'io server disconnect') void this.#reauthenticate();
    });

    socket.on('connect_error', (err) => {
      if (this.#isClosed()) return;
      if (AUTH_REFUSALS.has(err.message)) {
        // Refused by the server's middleware: no automatic retry either.
        void this.#reauthenticate();
        return;
      }
      this.#setState('reconnecting');
    });
  }

  close(): void {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    this.#setState('offline');
  }

  /**
   * The app came back to the foreground. A socket that gave up (a refresh
   * that failed on the network, say) gets another chance.
   */
  resume(): void {
    const socket = this.#socket;
    if (this.#isClosed() || !socket || socket.connected) return;
    socket.connect();
  }

  onBooking(listener: Listener<BookingUpdated>): () => void {
    this.#bookingListeners.add(listener);
    return () => this.#bookingListeners.delete(listener);
  }

  /** Called on every connect and reconnect: refetch, then apply newer events. */
  onResync(listener: () => void): () => void {
    const wrapped: Listener<undefined> = () => {
      listener();
    };
    this.#resyncListeners.add(wrapped);
    return () => this.#resyncListeners.delete(wrapped);
  }

  onState(listener: Listener<RealtimeState>): () => void {
    this.#stateListeners.add(listener);
    listener(this.#state);
    return () => this.#stateListeners.delete(listener);
  }

  /**
   * Refresh the token, then reconnect with it. Single-flight: `auth.expired`
   * is followed by the server's disconnect, and both land here.
   */
  #reauthenticate(): Promise<void> {
    this.#reauthenticating ??= (async () => {
      this.#setState('reconnecting');
      const refreshed = await this.#deps.refresh();
      if (this.#isClosed()) return;
      // Signed out (the provider closes us) or no network: the booking
      // screen polls, and resume() tries again on the next foreground.
      if (!refreshed) {
        this.#setState('offline');
        return;
      }
      this.#socket?.connect();
    })().finally(() => {
      this.#reauthenticating = null;
    });
    return this.#reauthenticating;
  }

  #setState(next: RealtimeState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#stateListeners) listener(next);
  }
}
