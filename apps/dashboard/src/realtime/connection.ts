import type { StaffSlotEvent } from '@laqum/shared';
import { SUBSCRIBE_EVENT, type SubscribedAck } from '@laqum/shared';
import { type Socket, io } from 'socket.io-client';
import type { ApiClient } from '../api/client.js';
import type { RealtimeStore } from '@laqum/shared';

/**
 * The socket half of the dashboard, and the resync that goes with it.
 *
 * THE ORDER MATTERS, and it is the opposite of the obvious one:
 *
 *   1. open the socket and subscribe — events start BUFFERING in the store;
 *   2. then fetch the snapshot;
 *   3. the store drains the buffer against the snapshot's version.
 *
 * Snapshot-then-subscribe would leave a gap: any change between the read and
 * the subscribe reaches nobody, and the grid is quietly wrong until that slot
 * next changes. Subscribing first makes the overlap a DUPLICATE rather than a
 * hole, and a duplicate is idempotent — the version comparison discards it.
 *
 * Every reconnect repeats the whole dance, because a socket that was down may
 * have missed anything.
 */

export const AUTH_EXPIRED_EVENT = 'auth.expired';
export const SLOT_UPDATED = 'slot.updated';

export interface ConnectionOptions {
  api: ApiClient;
  store: RealtimeStore;
  lotId: string;
  /** Overridden in tests; defaults to the page's own origin. */
  url?: string;
}

export class RealtimeConnection {
  readonly #api: ApiClient;
  readonly #store: RealtimeStore;
  readonly #lotId: string;
  readonly #url: string | undefined;
  #socket: Socket | null = null;
  #closed = false;

  /**
   * Read through a method, never the field directly, after an await.
   *
   * close() can run while a refresh or a snapshot fetch is in flight, so every
   * check after an await is load-bearing. Reading the private field directly
   * lets TypeScript narrow it from an earlier check and report the later ones
   * as dead code — they are not, and removing them would have the connection
   * reopen itself after being closed.
   */
  #isClosed(): boolean {
    return this.#closed;
  }

  constructor(options: ConnectionOptions) {
    this.#api = options.api;
    this.#store = options.store;
    this.#lotId = options.lotId;
    this.#url = options.url;
  }

  start(): void {
    this.#closed = false;
    this.#store.setConnection('connecting');
    this.#open();
  }

  close(): void {
    this.#closed = true;
    this.#socket?.close();
    this.#socket = null;
  }

  #open(): void {
    const token = this.#api.token;
    if (!token) {
      this.#store.setConnection('offline');
      return;
    }

    const socket = io(this.#url ?? '/', {
      // The token goes in the handshake auth payload, not a query string:
      // query strings end up in proxy logs and browser history, and this is a
      // live credential.
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
    this.#socket = socket;

    socket.on('connect', () => {
      void this.#subscribeThenSnapshot(socket);
    });

    socket.on(SLOT_UPDATED, (event: StaffSlotEvent) => {
      this.#store.applySlotEvent(event);
    });

    /*
     * The server disconnects us when the access token expires. That is not a
     * network failure, so it must not be handled like one: refresh the token
     * and open a NEW socket with it. Reconnecting with the same dead token
     * would fail the handshake forever.
     */
    socket.on(AUTH_EXPIRED_EVENT, () => {
      void this.#reauthenticate();
    });

    socket.on('disconnect', (reason: string) => {
      if (this.#isClosed()) return;
      // The grid is no longer trustworthy: events may have been missed.
      this.#store.reset();
      if (reason === 'io server disconnect') {
        // The server closed us deliberately; socket.io will not auto-retry.
        void this.#reauthenticate();
      }
    });

    socket.on('connect_error', (err: Error) => {
      if (this.#isClosed()) return;
      // A refused handshake is an auth problem, not a flaky network.
      if (err.message === 'BAD_TOKEN' || err.message === 'EXPIRED') {
        void this.#reauthenticate();
        return;
      }
      this.#store.setConnection('reconnecting');
    });
  }

  /** Refresh the access token, then reopen with it. */
  async #reauthenticate(): Promise<void> {
    if (this.#isClosed()) return;
    this.#store.setConnection('reconnecting');

    const refreshed = await this.#api.refresh();
    if (!refreshed.ok) {
      this.#store.setConnection('offline');
      return;
    }

    this.#socket?.close();
    this.#socket = null;
    if (!this.#isClosed()) this.#open();
  }

  /** Subscribe FIRST so events buffer, then fetch the snapshot. */
  async #subscribeThenSnapshot(socket: Socket): Promise<void> {
    const ack = await new Promise<{ ok: boolean; data?: SubscribedAck; error?: string }>(
      (resolve) => {
        socket.emit(
          SUBSCRIBE_EVENT,
          { lotId: this.#lotId, audience: 'staff' },
          (response: { ok: boolean; data?: SubscribedAck; error?: string }) => {
            resolve(response);
          },
        );
      },
    );

    if (!ack.ok) {
      // FORBIDDEN here means the lot_staff row is gone — the server re-checks
      // on every subscribe, so this is the authoritative answer, not a stale
      // client guess.
      this.#store.setConnection('offline');
      return;
    }

    await this.resync();
  }

  /** Fetch the snapshot and hand it to the store, draining buffered events. */
  async resync(): Promise<void> {
    const snapshot = await this.#api.lotSlots(this.#lotId);
    if (this.#isClosed()) return;

    if (!snapshot.ok) {
      this.#store.setConnection('reconnecting');
      return;
    }

    this.#store.applySnapshot(snapshot.data);
    this.#store.setConnection('live');
  }
}
