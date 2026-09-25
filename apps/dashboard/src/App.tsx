import { LOCALES, type Locale } from '@laqum/shared';
import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ApiClient, type StaffedLot } from './api/client.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { HeaderCounters } from './components/HeaderCounters.js';
import { QrScanner, detectTier } from './components/QrScanner.js';
import { ShortCodeEntry } from './components/ShortCodeEntry.js';
import { SlotDrawer } from './components/SlotDrawer.js';
import { errorText } from './errors.js';
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
 * Staff sign-in: a code by SMS, through the OTP "staff" audience — and, only
 * when the API offers it, the dev sign-in below it.
 *
 * The staff audience never reveals whether a number is staff: every number
 * gets the same answer to "send a code" and every failure the same answer to
 * "verify". So this screen says a code is on its way IF the number belongs to
 * a staff account, never "code sent", and has one message for a rejected code.
 *
 * The dev form appears only when GET /v1/auth/dev-login answers 204, which it
 * does only with DEV_AUTH on (the e2e suite, local testing). In production the
 * route does not exist, so the form is never offered.
 */
function SignIn({ onSignedIn }: { onSignedIn: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [devAvailable, setDevAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    void api.devLoginAvailable().then((available) => {
      if (active) setDevAvailable(available);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface p-6 text-ink">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <form
          data-testid="otp-sign-in"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            if (stage === 'phone') {
              void api.requestOtp(phone.trim()).then((result) => {
                setBusy(false);
                if (result.ok) setStage('code');
                else setError(signInError(t, result.error.code, stage));
              });
              return;
            }
            void api.verifyOtp(phone.trim(), code.trim()).then((result) => {
              setBusy(false);
              if (result.ok) {
                api.setSession(result.data);
                onSignedIn();
              } else {
                setError(signInError(t, result.error.code, stage));
              }
            });
          }}
          className="flex flex-col gap-4 rounded-2xl border-2 border-line bg-surface-raised p-6"
        >
          <h1 className="text-2xl font-extrabold">{t('app.name')}</h1>

          {stage === 'phone' ? (
            <>
              <p className="text-sm font-semibold text-ink-muted">{t('signIn.otpIntro')}</p>
              <input
                data-testid="otp-phone"
                value={phone}
                onChange={(event) => {
                  setPhone(event.target.value);
                }}
                inputMode="tel"
                autoComplete="tel"
                placeholder="+2519…"
                aria-label={t('signIn.phone')}
                className="rounded-xl border-2 border-line bg-surface px-4 py-3 text-lg font-bold tabular-nums"
              />
            </>
          ) : (
            <>
              <p data-testid="otp-on-its-way" className="text-sm font-semibold text-ink-muted">
                {t('signIn.codeOnItsWay', { phone: phone.trim() })}
              </p>
              <input
                data-testid="otp-code"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                aria-label={t('signIn.code')}
                className="rounded-xl border-2 border-line bg-surface px-4 py-3 text-center text-2xl font-extrabold tracking-[0.4em] tabular-nums"
              />
            </>
          )}

          {error ? (
            <p role="alert" data-testid="otp-error" className="text-sm font-bold text-danger">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            data-testid={stage === 'phone' ? 'otp-send' : 'otp-verify'}
            disabled={busy}
            className="min-h-14 rounded-xl bg-accent px-4 py-3 text-lg font-extrabold text-accent-ink disabled:opacity-50"
          >
            {busy ? '…' : stage === 'phone' ? t('signIn.sendCode') : t('signIn.verify')}
          </button>

          {stage === 'code' ? (
            <button
              type="button"
              data-testid="otp-change-number"
              onClick={() => {
                setStage('phone');
                setCode('');
                setError(null);
              }}
              className="text-sm font-bold text-accent underline"
            >
              {t('signIn.changeNumber')}
            </button>
          ) : null}
        </form>

        {devAvailable ? <DevSignIn onSignedIn={onSignedIn} /> : null}
      </div>
    </main>
  );
}

/** What a failed sign-in step tells the attendant, by error code. */
function signInError(t: TFunction, code: string, stage: 'phone' | 'code'): string {
  switch (code) {
    case 'OTP_INVALID':
      return t('signIn.error.codeRejected');
    case 'RATE_LIMITED':
      return t('signIn.error.rateLimited');
    case 'VALIDATION_ERROR':
      return stage === 'phone' ? t('signIn.error.badPhone') : t('signIn.error.badCode');
    case 'NETWORK':
      return t('signIn.error.network');
    default:
      return t('signIn.error.failed');
  }
}

/**
 * Dev sign-in: any seeded number, no code. Shown only when the API offers it
 * (see SignIn). Its test ids are the e2e suite's sign-in path.
 */
function DevSignIn({ onSignedIn }: { onSignedIn: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const [phone, setPhone] = useState('+251911000001');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
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
            setError(errorText(t, result.error));
          }
        });
      }}
      className="flex flex-col gap-4 rounded-2xl border-2 border-dashed border-line bg-surface-raised p-6"
    >
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
        className="min-h-14 rounded-xl border-2 border-line px-4 py-3 text-lg font-extrabold disabled:opacity-50"
      >
        {busy ? '…' : t('signIn.submit')}
      </button>
    </form>
  );
}

/** Re-exported so the scanner tier can be probed from a test without a camera. */
export { detectTier };
