import { useTranslation } from 'react-i18next';
import type { ConnectionState } from '@laqum/shared';

/**
 * Is what I am looking at actually live?
 *
 * The brief requires this to be visible, and the reason is specific: a
 * dashboard that has silently stopped receiving events looks EXACTLY like a
 * quiet lot. An attendant would keep working from a frozen grid and turn
 * someone away from a slot that emptied ten minutes ago.
 *
 * WHY IT IS NOT GREEN ANY MORE. It was, and that was the bug: an empty lot is
 * a field of green tiles, so a small green dot in the corner said nothing at
 * all. `live` is now an INVERTED chip — near-black on the light theme,
 * near-white on the dark one. It is the only inverted element on the screen,
 * which is what makes it legible against any grid, and it is not a status hue
 * so it cannot collide with a future slot colour.
 *
 * Losing the connection then departs from that dark chip in a direction
 * impossible to miss: the chip turns solid orange, then red, grows a warning
 * glyph, and starts pulsing. Three channels, as everywhere else in this UI —
 * colour, shape, and words — so none of it depends on hue alone.
 */

export interface ConnectionIndicatorProps {
  state: ConnectionState;
  onRetry?: () => void;
}

interface Presentation {
  /** Chip surface and ink, from the shared connection palette. */
  chip: string;
  dot: string;
  /** Geometric, not emoji — see statusPresentation.ts for why. */
  glyph: string;
  labelKey: string;
  /** False when the grid may be out of date. Drives the alarm treatment. */
  trustworthy: boolean;
}

const PRESENTATION: Record<ConnectionState, Presentation> = {
  connecting: {
    chip: 'bg-conn-connecting text-conn-connecting-ink',
    dot: 'bg-conn-connecting-dot',
    glyph: '◌',
    labelKey: 'connection.connecting',
    trustworthy: false,
  },
  live: {
    chip: 'bg-conn-live text-conn-live-ink',
    dot: 'bg-conn-live-dot',
    glyph: '◉',
    labelKey: 'connection.live',
    trustworthy: true,
  },
  reconnecting: {
    chip: 'bg-conn-reconnecting text-conn-reconnecting-ink',
    dot: 'bg-conn-reconnecting-dot',
    // '!' not a warning sign: U+26A0 has emoji presentation on several
    // platforms, which is the same tofu risk the tile glyphs avoid.
    glyph: '!',
    labelKey: 'connection.reconnecting',
    trustworthy: false,
  },
  offline: {
    chip: 'bg-conn-offline text-conn-offline-ink',
    dot: 'bg-conn-offline-dot',
    glyph: '!',
    labelKey: 'connection.offline',
    trustworthy: false,
  },
};

export function ConnectionIndicator({
  state,
  onRetry,
}: ConnectionIndicatorProps): React.JSX.Element {
  const { t } = useTranslation();
  const presentation = PRESENTATION[state];

  return (
    <div
      data-testid="connection-indicator"
      data-connection={state}
      data-trustworthy={presentation.trustworthy ? 'true' : 'false'}
      /*
       * A live region: the attendant is looking at the grid, not at this
       * corner, so a change of connection has to announce itself.
       */
      role="status"
      aria-live="polite"
      className={[
        presentation.chip,
        'flex items-center gap-2 rounded-xl px-3 py-2 shadow-sm',
        // Only the degraded states pulse. A steady chip is the normal one, so
        // motion always means "look at me".
        presentation.trustworthy ? '' : 'animate-pulse ring-2 ring-conn-offline',
      ].join(' ')}
    >
      <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${presentation.dot}`} />
      <span aria-hidden="true" className="text-sm leading-none font-bold">
        {presentation.glyph}
      </span>
      <span className="text-sm font-bold whitespace-nowrap">{t(presentation.labelKey)}</span>

      {!presentation.trustworthy && onRetry ? (
        <button
          type="button"
          data-testid="retry-connection"
          onClick={onRetry}
          // Inherits the chip's ink so it stays legible on every variant.
          className="ml-1 rounded-lg border-2 border-current px-2 py-1 text-xs font-bold"
        >
          {t('connection.retry')}
        </button>
      ) : null}
    </div>
  );
}
