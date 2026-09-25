import { RealtimeStore, type RealtimeState, type StaffSlotEvent } from '@laqum/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiClient, ApiError } from './api/client.js';
import type { ActionKind } from './components/SlotDrawer.js';
import { RealtimeConnection } from './realtime/connection.js';

/**
 * The dashboard's whole state machine, kept out of the view.
 *
 * NO OPTIMISTIC UPDATES. An action sets `pending` and nothing else. The grid
 * changes only when the server says so — either because the action's own
 * response came back, or because the realtime event arrived. Both paths end at
 * the same place, which is why a slow response and a fast event cannot
 * disagree.
 *
 * ON STATE_CONFLICT: refetch, then say what actually happened. The booking
 * moved on under the attendant's hands; telling them "conflict" would just
 * make them press the button again. Telling them "that car was already checked
 * out" ends the confusion.
 */

export interface ActionState {
  slotId: string;
  kind: ActionKind;
}

export interface LotDashboard {
  state: RealtimeState;
  selected: StaffSlotEvent | null;
  select: (slot: StaffSlotEvent | null) => void;
  action: ActionState | null;
  error: ApiError | null;
  conflictNote: string | null;
  amountDueSantim: number | null;
  runAction: (kind: ActionKind, input: { vehiclePlate?: string }) => Promise<void>;
  checkInByCode: (code: string) => Promise<void>;
  checkInBusy: boolean;
  checkInError: string | null;
  clearCheckInError: () => void;
  retry: () => void;
}

export function useLotDashboard(api: ApiClient, lotId: string | null): LotDashboard {
  const { t } = useTranslation();
  const store = useMemo(() => new RealtimeStore(), []);
  const connectionRef = useRef<RealtimeConnection | null>(null);

  const [state, setState] = useState<RealtimeState>(() => store.getState());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [conflictNote, setConflictNote] = useState<string | null>(null);
  const [amountDueSantim, setAmountDue] = useState<number | null>(null);
  const [checkInBusy, setCheckInBusy] = useState(false);
  const [checkInError, setCheckInError] = useState<string | null>(null);

  useEffect(() => store.subscribe(setState), [store]);

  useEffect(() => {
    if (!lotId) return;
    const connection = new RealtimeConnection({ api, store, lotId });
    connectionRef.current = connection;
    connection.start();
    return () => {
      connection.close();
      connectionRef.current = null;
    };
  }, [api, store, lotId]);

  /*
   * The selected slot is looked up FROM THE STORE by id, never held as a copy.
   *
   * If the drawer held its own snapshot of the slot, a realtime event would
   * update the grid behind it and leave the drawer showing a stale status —
   * with action buttons for a state the slot is no longer in.
   */
  const selected = useMemo(
    () => state.slots.find((slot) => slot.slotId === selectedId) ?? null,
    [state.slots, selectedId],
  );

  const select = useCallback((slot: StaffSlotEvent | null) => {
    setSelectedId(slot?.slotId ?? null);
    setError(null);
    setConflictNote(null);
    setAmountDue(null);
  }, []);

  /** Refetch and describe what the booking actually did. */
  const resolveConflict = useCallback(
    async (kind: ActionKind): Promise<void> => {
      await connectionRef.current?.resync();
      const fresh = store.getState().slots.find((slot) => slot.slotId === selectedId);
      setConflictNote(
        t('conflict.explained', {
          action: t(`action.${kind}`),
          status: fresh ? t(`slot.${fresh.displayStatus}`) : t('conflict.unknown'),
        }),
      );
    },
    [store, selectedId, t],
  );

  const runAction = useCallback(
    async (kind: ActionKind, input: { vehiclePlate?: string }): Promise<void> => {
      if (!lotId || !selected) return;

      setAction({ slotId: selected.slotId, kind });
      setError(null);
      setConflictNote(null);

      // A check-out returns the bill: what is due, so the cash button appears
      // without a second round trip. Read where the response is still typed.
      let billed: number | null | undefined;

      const result = await (async () => {
        switch (kind) {
          case 'park':
            return api.parkWalkIn(lotId, {
              slotId: selected.slotId,
              ...(input.vehiclePlate ? { vehiclePlate: input.vehiclePlate } : {}),
            });
          case 'checkOut': {
            if (!selected.bookingId) {
              return { ok: false, error: { code: 'NOT_FOUND', message: 'No booking' } } as const;
            }
            const outcome = await api.checkOut(selected.bookingId);
            if (outcome.ok) {
              billed = outcome.data.settled ? null : outcome.data.bill.amountDueSantim;
            }
            return outcome;
          }
          case 'cash':
            return selected.bookingId && amountDueSantim !== null
              ? api.recordCash(selected.bookingId, amountDueSantim)
              : ({ ok: false, error: { code: 'NOT_FOUND', message: 'Nothing due' } } as const);
          case 'outOfService':
            return api.setSlotService(selected.slotId, false);
          case 'inService':
            return api.setSlotService(selected.slotId, true);
        }
      })();

      setAction(null);

      if (!result.ok) {
        setError(result.error);
        // The two codes that mean "reality moved" rather than "you did it
        // wrong". Both are resolved by looking again, not by retrying.
        if (result.error.code === 'STATE_CONFLICT' || result.error.code === 'SLOT_TAKEN') {
          await resolveConflict(kind);
        }
        return;
      }

      if (billed !== undefined) setAmountDue(billed);
      if (kind === 'cash') setAmountDue(null);

      /*
       * Resync rather than patching local state from the response.
       *
       * The realtime event for this change is already on its way and carries
       * the authoritative row. Resyncing keeps ONE path into the grid, so the
       * view cannot end up in a state no snapshot would ever produce.
       */
      await connectionRef.current?.resync();
    },
    [api, lotId, selected, amountDueSantim, resolveConflict],
  );

  const checkInByCode = useCallback(
    async (code: string): Promise<void> => {
      setCheckInBusy(true);
      setCheckInError(null);

      const result = await api.checkIn(code);
      setCheckInBusy(false);

      if (!result.ok) {
        setCheckInError(t(`error.${result.error.code}`, { defaultValue: result.error.message }));
        return;
      }

      await connectionRef.current?.resync();
      setSelectedId(result.data.booking.slotId);
    },
    [api, t],
  );

  const retry = useCallback(() => {
    connectionRef.current?.start();
  }, []);

  return {
    state,
    selected,
    select,
    action,
    error,
    conflictNote,
    amountDueSantim,
    runAction,
    checkInByCode,
    checkInBusy,
    checkInError,
    clearCheckInError: () => {
      setCheckInError(null);
    },
    retry,
  };
}
