import type { StaffSlotEvent } from '@laqum/shared';
import { useTranslation } from 'react-i18next';
import { presentationFor } from './statusPresentation.js';

/**
 * One slot in the grid: TAP ONE of every primary action.
 *
 * The whole tile is the button, not a small chevron inside it, because this is
 * used with a thumb while holding a ticket in the other hand.
 */

export interface SlotTileProps {
  slot: StaffSlotEvent;
  onSelect: (slot: StaffSlotEvent) => void;
  /** True while an action on this slot is awaiting the server. */
  pending?: boolean;
}

export function SlotTile({ slot, onSelect, pending = false }: SlotTileProps): React.JSX.Element {
  const { t } = useTranslation();
  const presentation = presentationFor(slot.displayStatus);
  const label = t(presentation.labelKey);

  return (
    <button
      type="button"
      data-testid={`slot-${slot.label}`}
      data-status={slot.displayStatus}
      data-pending={pending ? 'true' : 'false'}
      onClick={() => {
        onSelect(slot);
      }}
      /*
       * The accessible name carries the status in WORDS. A screen reader user
       * and a sighted user in bright sun are solving the same problem: the
       * colour is not available to them.
       */
      aria-label={`${slot.label}, ${label}${slot.vehiclePlate ? `, ${slot.vehiclePlate}` : ''}`}
      className={[
        presentation.surface,
        'relative flex aspect-4/3 min-h-28 w-full flex-col items-center justify-center gap-1',
        'rounded-xl border-2 border-black/10 p-2 shadow-sm transition',
        'hover:brightness-105 active:scale-[0.98]',
        pending ? 'animate-pulse ring-4 ring-accent ring-offset-2' : '',
      ].join(' ')}
    >
      {/* Channel 2: the glyph. Survives greyscale and glare. */}
      <span aria-hidden="true" className="text-3xl leading-none font-bold">
        {presentation.glyph}
      </span>

      <span className="text-xl leading-none font-extrabold tabular-nums">{slot.label}</span>

      {/* Channel 3: the word. Never omitted, even when space is tight. */}
      <span className="text-center text-xs leading-tight font-semibold uppercase">{label}</span>

      {slot.vehiclePlate ? (
        <span className="max-w-full truncate rounded bg-black/15 px-1.5 py-0.5 text-[11px] font-bold tabular-nums">
          {slot.vehiclePlate}
        </span>
      ) : null}

      {pending ? (
        <span className="absolute inset-x-1 bottom-1 rounded bg-accent px-1 py-0.5 text-[10px] font-bold text-accent-ink">
          {t('action.pending')}
        </span>
      ) : null}
    </button>
  );
}
