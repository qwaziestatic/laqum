import { LOCALES, type Locale } from '@laqum/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiClient, type StaffedLot } from './api/client.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { HeaderCounters } from './components/HeaderCounters.js';
import { QrScanner, detectTier } from './components/QrScanner.js';
import { ShortCodeEntry } from './components/ShortCodeEntry.js';
import { SlotDrawer } from './components/SlotDrawer.js';
import { SlotTile } from './components/SlotTile.js';
import { applyTheme, storedTheme, type ThemeChoice } from './theme.js';
import { useLotDashboard } from './useLotDashboard.js';

/**
 * The attendant console.
 *
 * TABLET FIRST. The grid is sized for a 10" landscape tablet mounted at a
 * booth; it reflows to one column on a phone, but the phone is the fallback,
 * not the target.
 *
 * TWO TAPS, MAXIMUM. Scan is one tap from here. A slot action is two: tap the
 * tile, tap the action. Nothing primary is deeper.
 */

const api = new ApiClient();

export function App(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme);
  const [lots, setLots] = useState<StaffedLot[]>([]);
  const [lotId, setLotId] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(api.session !== null);
  const [scanning, setScanning] = useState(false);
  const [typing, setTyping] = useState(false);

  const dashboard = useLotDashboard(api, lotId);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!signedIn) return;
    void (async () => {
      const result = await api.staffedLots();
      if (!result.ok) return;
      setLots(result.data.lots);
      setLotId((current) => current ?? result.data.lots[0]?.id ?? null);
    })();
  }, [signedIn]);

  if (!signedIn) {
    return (
      <SignIn
        onSignedIn={() => {
          setSignedIn(true);
        }}
      />
    );
  }

  const { state } = dashboard;
  const lot = lots.find((l) => l.id === lotId);

  return (
    <div className="min-h-screen bg-surface text-ink">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b-2 border-line bg-surface-raised px-4 py-3">
        <div className="mr-auto">
          {/*
           * An attendant may staff more than one lot — the seed puts one
           * person on both — so the lot is a control, not a caption. With a
           * single lot it renders as plain text rather than a select with one
           * option, which would only invite a pointless tap.
           */}
          {lots.length > 1 ? (
            <select
              data-testid="lot-picker"
              value={lotId ?? ''}
              onChange={(event) => {
                setLotId(event.target.value);
              }}
              aria-label={t('lot.choose')}
              className="max-w-[22rem] rounded-lg border-2 border-line bg-surface px-2 py-1 text-2xl font-extrabold text-ink"
            >
              {lots.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          ) : (
            <h1 className="text-2xl font-extrabold">{lot?.name ?? t('app.name')}</h1>
          )}
          <p className="text-xs font-semibold text-ink-muted">{t('app.attendantConsole')}</p>
        </div>

        <HeaderCounters counts={state.counts} />

        <ConnectionIndicator state={state.connection} onRetry={dashboard.retry} />

        {/* TAP ONE of two: scan. */}
        <button
          type="button"
          data-testid="scan-button"
          onClick={() => {
            setScanning(true);
          }}
          className="min-h-14 rounded-xl bg-accent px-5 py-3 text-lg font-extrabold text-accent-ink shadow"
        >
          {t('action.scan')}
        </button>

        <button
          type="button"
          data-testid="short-code-button"
          onClick={() => {
            setTyping(true);
          }}
          className="min-h-14 rounded-xl border-2 border-line px-4 py-3 font-bold"
        >
          {t('action.typeCode')}
        </button>

        <ThemeToggle theme={theme} onChange={setTheme} />
        <LanguageToggle
          current={i18n.language as Locale}
          onChange={(locale) => {
            void i18n.changeLanguage(locale);
          }}
        />
      </header>

      <main className="p-4">
        {state.loading ? (
          <p
            data-testid="grid-loading"
            className="py-16 text-center text-lg font-bold text-ink-muted"
          >
            {t('grid.loading')}
          </p>
        ) : state.slots.length === 0 ? (
          <p className="py-16 text-center text-lg font-bold text-ink-muted">{t('grid.empty')}</p>
        ) : (
          <ul
            data-testid="lot-grid"
            data-lot-version={state.snapshotVersion}
            /*
             * auto-fill with a min track: the grid keeps a consistent tile
             * SIZE and lets the column count follow the screen, rather than
             * stretching four tiles across a 10" tablet.
             */
            className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3"
          >
            {state.slots.map((slot) => (
              <li key={slot.slotId}>
                <SlotTile
                  slot={slot}
                  onSelect={dashboard.select}
                  pending={dashboard.action?.slotId === slot.slotId}
                />
              </li>
            ))}
          </ul>
        )}
      </main>

      {dashboard.selected ? (
        <SlotDrawer
          slot={dashboard.selected}
          onClose={() => {
            dashboard.select(null);
          }}
          onAction={(kind, input) => {
            void dashboard.runAction(kind, input);
          }}
          pending={dashboard.action?.kind ?? null}
          error={dashboard.error}
          conflictNote={dashboard.conflictNote}
          amountDueSantim={dashboard.amountDueSantim}
        />
      ) : null}

      {scanning ? (
        <QrScanner
          onScan={(text) => {
            setScanning(false);
            void dashboard.checkInByCode(text);
          }}
          onClose={() => {
            setScanning(false);
          }}
        />
      ) : null}

      {typing ? (
        <ShortCodeEntry
          busy={dashboard.checkInBusy}
          error={dashboard.checkInError}
          onSubmit={(code) => {
            void dashboard.checkInByCode(code).then(() => {
              setTyping(false);
            });
          }}
          onClose={() => {
            dashboard.clearCheckInError();
            setTyping(false);
          }}
        />
      ) : null}
    </div>
  );
}

function ThemeToggle({
  theme,
  onChange,
}: {
  theme: ThemeChoice;
  onChange: (choice: ThemeChoice) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const next: Record<ThemeChoice, ThemeChoice> = {
    system: 'light',
    light: 'dark',
    dark: 'system',
  };

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      data-theme-choice={theme}
      aria-label={t('theme.toggle')}
      onClick={() => {
        onChange(next[theme]);
      }}
      className="min-h-14 rounded-xl border-2 border-line px-4 py-3 font-bold"
    >
      {t(`theme.${theme}`)}
    </button>
  );
}

function LanguageToggle({
  current,
  onChange,
}: {
  current: Locale;
  onChange: (locale: Locale) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex gap-1" role="group" aria-label={t('common.language')}>
      {LOCALES.map((locale) => (
        <button
          key={locale}
          type="button"
          data-testid={`lang-${locale}`}
          onClick={() => {
            onChange(locale);
          }}
          aria-pressed={current === locale}
          className={[
            'min-h-14 rounded-xl border-2 px-3 py-3 font-bold',
            current === locale ? 'border-accent bg-accent text-accent-ink' : 'border-line',
          ].join(' ')}
        >
          {locale === 'am' ? 'አማ' : 'EN'}
        </button>
      ))}
    </div>
  );
}

/**
 * Dev sign-in.
 *
 * The endpoint only exists when the API was started with DEV_AUTH=true and a
 * non-production NODE_ENV, so in a real deployment this form simply 404s. The
 * production sign-in is the OTP flow, which is Phase 4's screen — the console
 * is opened by an operator admin, not self-served.
 */
function SignIn({ onSignedIn }: { onSignedIn: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const [phone, setPhone] = useState('+251911000001');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface p-6 text-ink">
      <form
        data-testid="sign-in"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          void api.devLogin(phone.trim()).then((result) => {
            setBusy(false);
            if (result.ok) {
              api.setSession(result.data);
              onSignedIn();
            } else {
              setError(result.error.message);
            }
          });
        }}
        className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border-2 border-line bg-surface-raised p-6"
      >
        <h1 className="text-2xl font-extrabold">{t('app.name')}</h1>
        <p className="text-sm font-semibold text-ink-muted">{t('signIn.devOnly')}</p>

        <input
          data-testid="sign-in-phone"
          value={phone}
          onChange={(event) => {
            setPhone(event.target.value);
          }}
          inputMode="tel"
          aria-label={t('signIn.phone')}
          className="rounded-xl border-2 border-line bg-surface px-4 py-3 text-lg font-bold tabular-nums"
        />

        {error ? (
          <p role="alert" data-testid="sign-in-error" className="text-sm font-bold text-danger">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          data-testid="sign-in-submit"
          disabled={busy}
          className="min-h-14 rounded-xl bg-accent px-4 py-3 text-lg font-extrabold text-accent-ink disabled:opacity-50"
        >
          {busy ? '…' : t('signIn.submit')}
        </button>
      </form>
    </main>
  );
}

/** Re-exported so the scanner tier can be probed from a test without a camera. */
export { detectTier };
