import type { LotCounts, SlotDisplayStatus } from '@laqum/shared';
import { useTranslation } from 'react-i18next';
import { presentationFor } from './statusPresentation.js';

/**
 * The counts across the top.
 *
 * These are DERIVED from the slot rows by the store on every change, never
 * kept as running totals. A tally that is incremented per event drifts the
 * moment an event is dropped, redelivered, or applied out of order — and a
 * header that disagrees with the grid below it is worse than no header,
 * because the attendant cannot tell which one is lying.
 */

export interface HeaderCountersProps {
  counts: Omit<LotCounts, 'lotId' | 'lotVersion'>;
}

const ORDER: { status: SlotDisplayStatus; key: keyof HeaderCountersProps['counts'] }[] = [
  { status: 'free', key: 'free' },
  { status: 'reserved', key: 'reserved' },
  { status: 'occupied', key: 'occupied' },
  { status: 'overstay', key: 'overstay' },
  { status: 'out_of_service', key: 'outOfService' },
];

export function HeaderCounters({ counts }: HeaderCountersProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <ul className="flex flex-wrap gap-2" data-testid="header-counters">
      {ORDER.map(({ status, key }) => {
        const presentation = presentationFor(status);
        const value = counts[key];
        return (
          <li
            key={status}
            data-testid={`count-${status}`}
            data-count={value}
            className={[
              presentation.surface,
              'flex min-w-20 items-center gap-2 rounded-lg border-2 border-black/10 px-3 py-2',
              // Overstay is the one that costs money; it stays prominent even
              // at zero so its position in the row never shifts.
              status === 'overstay' && value > 0 ? 'ring-2 ring-danger' : '',
            ].join(' ')}
          >
            <span aria-hidden="true" className="text-lg leading-none font-bold">
              {presentation.glyph}
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-xl font-extrabold tabular-nums">{value}</span>
              <span className="text-[10px] font-semibold uppercase">
                {t(presentation.labelKey)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
