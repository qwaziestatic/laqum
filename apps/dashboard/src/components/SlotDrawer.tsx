import { LOCALES, type Locale, type StaffSlotEvent, formatBirr, formatClock } from '@laqum/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiError } from '../api/client.js';
import { errorText } from '../errors.js';
import { presentationFor } from './statusPresentation.js';

/**
 * The second tap.
 *
 * TAP ONE selects a slot in the grid; TAP TWO is the action in here. Nothing a
 * primary action needs sits deeper than that: park, check out, take cash, and
 * put a slot in or out of service are all one button on this panel.
 *
 * NO OPTIMISTIC UPDATES. The brief is explicit and the reason is money: a tile
 * that flips to "free" before the server agrees will, on a conflict, flip back
 * — and in between, an attendant may have parked a second car on it. So an
 * action shows a PENDING state and changes nothing until the server confirms,
 * either by returning success or by the realtime event arriving.
 */

export type ActionKind = 'park' | 'checkOut' | 'cash' | 'outOfService' | 'inService';

export interface SlotDrawerProps {
  slot: StaffSlotEvent;
  onClose: () => void;
  onAction: (kind: ActionKind, input: { vehiclePlate?: string }) => void;
  /** The action awaiting the server, if any. */
  pending: ActionKind | null;
  /** Set when the last action was refused. */
  error: ApiError | null;
  /** Set when a STATE_CONFLICT forced a refetch — says what actually happened. */
  conflictNote: string | null;
  amountDueSantim?: number | null;
}

export function SlotDrawer({
  slot,
  onClose,
  onAction,
  pending,
  error,
  conflictNote,
  amountDueSantim,
}: SlotDrawerProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const locale: Locale = LOCALES.find((l) => l === i18n.language) ?? 'am';
  const [plate, setPlate] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const presentation = presentationFor(slot.displayStatus);

  // Focus moves into the drawer so a keyboard or screen-reader user is not
  // left behind on the grid.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const busy = pending !== null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-testid="slot-drawer">
      <button
        type="button"
        aria-label={t('action.close')}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${t('drawer.title')} ${slot.label}`}
        className="relative flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto border-l-2 border-line bg-surface-raised p-5 shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className={`${presentation.surface} flex size-14 items-center justify-center rounded-xl border-2 border-black/10 text-2xl font-bold`}
            >
              {presentation.glyph}
            </span>
            <div>
              <h2 className="text-2xl font-extrabold text-ink">{slot.label}</h2>
              <p className="text-sm font-semibold text-ink-muted">
                {t('drawer.zone', { zone: slot.zone })} · {t(presentation.labelKey)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="drawer-close"
            className="rounded-lg border-2 border-line px-3 py-2 text-sm font-bold text-ink"
          >
            {t('action.close')}
          </button>
        </header>

        {/*
         * A conflict is explained, not swallowed. The attendant asked for
         * something the booking had already moved past — they need to know
         * what it moved to, or they will simply try again.
         */}
        {conflictNote ? (
          <p
            data-testid="conflict-note"
            role="alert"
            className="rounded-lg border-2 border-slot-overstay bg-slot-overstay px-3 py-2 text-sm font-bold text-slot-overstay-ink"
          >
            {conflictNote}
          </p>
        ) : null}

        {error && !conflictNote ? (
          <p
            data-testid="drawer-error"
            role="alert"
            className="rounded-lg border-2 border-danger px-3 py-2 text-sm font-bold text-danger"
          >
            {errorText(t, error)}
          </p>
        ) : null}

        <dl className="grid grid-cols-2 gap-2 text-sm">
          {slot.vehiclePlate ? (
            <Detail label={t('drawer.plate')} value={slot.vehiclePlate} testId="drawer-plate" />
          ) : null}
          {slot.plannedEndAt ? (
            <Detail label={t('drawer.until')} value={formatTime(slot.plannedEndAt, locale)} />
          ) : null}
          {slot.holdExpiresAt ? (
            <Detail label={t('drawer.holdUntil')} value={formatTime(slot.holdExpiresAt, locale)} />
          ) : null}
          {slot.source ? (
            <Detail label={t('drawer.source')} value={t(`source.${slot.source}`)} />
          ) : null}
        </dl>

        <div className="flex flex-col gap-3">
          {slot.displayStatus === 'free' ? (
            <>
              <label className="flex flex-col gap-1 text-sm font-bold text-ink">
                {t('drawer.plateOptional')}
                <input
                  data-testid="walk-in-plate"
                  value={plate}
                  onChange={(e) => {
                    setPlate(e.target.value.toUpperCase());
                  }}
                  inputMode="text"
                  autoCapitalize="characters"
                  placeholder="AA-12345"
                  className="rounded-lg border-2 border-line bg-surface px-3 py-3 text-lg font-bold tabular-nums text-ink"
                />
              </label>
              <ActionButton
                testId="action-park"
                label={t('action.park')}
                busy={pending === 'park'}
                disabled={busy}
                tone="accent"
                onClick={() => {
                  onAction('park', plate.trim() ? { vehiclePlate: plate.trim() } : {});
                }}
              />
            </>
          ) : null}

          {slot.displayStatus === 'occupied' || slot.displayStatus === 'overstay' ? (
            <ActionButton
              testId="action-check-out"
              label={t('action.checkOut')}
              busy={pending === 'checkOut'}
              disabled={busy}
              tone="accent"
              onClick={() => {
                onAction('checkOut', {});
              }}
            />
          ) : null}

          {typeof amountDueSantim === 'number' && amountDueSantim > 0 ? (
            <ActionButton
              testId="action-cash"
              label={t('action.recordCash', { amount: formatBirr(amountDueSantim) })}
              busy={pending === 'cash'}
              disabled={busy}
              tone="ok"
              onClick={() => {
                onAction('cash', {});
              }}
            />
          ) : null}

          {slot.displayStatus === 'free' ? (
            <ActionButton
              testId="action-out-of-service"
              label={t('action.outOfService')}
              busy={pending === 'outOfService'}
              disabled={busy}
              tone="plain"
              onClick={() => {
                onAction('outOfService', {});
              }}
            />
          ) : null}

          {slot.displayStatus === 'out_of_service' ? (
            <ActionButton
              testId="action-in-service"
              label={t('action.inService')}
              busy={pending === 'inService'}
              disabled={busy}
              tone="accent"
              onClick={() => {
                onAction('inService', {});
              }}
            />
          ) : null}
        </div>

        {busy ? (
          <p
            data-testid="drawer-pending"
            role="status"
            aria-live="polite"
            className="rounded-lg bg-surface-sunken px-3 py-2 text-sm font-bold text-ink-muted"
          >
            {/* Explicitly NOT "done". Nothing has changed until the server says so. */}
            {t('action.waitingForServer')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Detail({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg bg-surface-sunken px-3 py-2">
      <dt className="text-[11px] font-semibold uppercase text-ink-muted">{label}</dt>
      <dd className="text-base font-bold text-ink" {...(testId ? { 'data-testid': testId } : {})}>
        {value}
      </dd>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  busy,
  disabled,
  tone,
  testId,
}: {
  label: string;
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
  tone: 'accent' | 'ok' | 'plain';
  testId: string;
}): React.JSX.Element {
  const tones = {
    accent: 'bg-accent text-accent-ink',
    ok: 'bg-ok text-surface',
    plain: 'bg-surface-sunken text-ink border-2 border-line',
  } as const;

  return (
    <button
      type="button"
      data-testid={testId}
      data-busy={busy ? 'true' : 'false'}
      onClick={onClick}
      disabled={disabled}
      className={[
        tones[tone],
        'min-h-14 rounded-xl px-4 py-3 text-lg font-extrabold shadow-sm transition',
        'active:scale-[0.99] disabled:opacity-50',
      ].join(' ')}
    >
      {busy ? '…' : label}
    </button>
  );
}

/**
 * Addis Ababa time, in the reader's clock: "ከሰዓት 8:05" in Amharic (the
 * Ethiopian clock), "14:05" in English (shared clockDisplay.ts). It used the
 * browser's locale and zone, which showed an English "PM" on an Amharic
 * screen, in whatever zone the laptop was set to.
 */
function formatTime(iso: string, locale: Locale): string {
  return formatClock(new Date(iso), locale);
}
