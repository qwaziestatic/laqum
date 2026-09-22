import { useTranslation } from 'react-i18next';
import type { ConnectionState } from '../realtime/store.js';

/**
 * Is what I am looking at actually live?
 *
 * The brief requires this to be visible, and the reason is specific: a
 * dashboard that has silently stopped receiving events looks EXACTLY like a
 * quiet lot. An attendant would keep working from a frozen grid and turn
 * someone away from a slot that emptied ten minutes ago. So the indicator
 * states the connection in words, not just a coloured dot, and says plainly
 * when the view cannot be trusted.
 */

export interface ConnectionIndicatorProps {
  state: ConnectionState;
  onRetry?: () => void;
}

const PRESENTATION: Record<
  ConnectionState,
  { dot: string; text: string; labelKey: string; trustworthy: boolean }
> = {
  connecting: {
    dot: 'bg-ink-muted',
    text: 'text-ink-muted',
    labelKey: 'connection.connecting',
    trustworthy: false,
  },
  live: {
    dot: 'bg-ok',
    text: 'text-ok',
    labelKey: 'connection.live',
    trustworthy: true,
  },
  reconnecting: {
    dot: 'bg-slot-overstay',
    text: 'text-ink',
    labelKey: 'connection.reconnecting',
    trustworthy: false,
  },
  offline: {
    dot: 'bg-danger',
    text: 'text-danger',
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
      /*
       * A live region: the attendant is looking at the grid, not at this
       * corner, so a change of connection has to announce itself.
       */
      role="status"
      aria-live="polite"
      className={[
        'flex items-center gap-2 rounded-lg border-2 px-3 py-2',
        presentation.trustworthy ? 'border-line' : 'border-danger bg-surface-sunken',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={`size-3 shrink-0 rounded-full ${presentation.dot} ${
          state === 'reconnecting' ? 'animate-pulse' : ''
        }`}
      />
      <span className={`text-sm font-bold ${presentation.text}`}>{t(presentation.labelKey)}</span>

      {!presentation.trustworthy && onRetry ? (
        <button
          type="button"
          data-testid="retry-connection"
          onClick={onRetry}
          className="ml-1 rounded bg-accent px-2 py-1 text-xs font-bold text-accent-ink"
        >
          {t('connection.retry')}
        </button>
      ) : null}
    </div>
  );
}
