import { SHORT_CODE_LENGTH, looksLikeShortCode } from '@laqum/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Tier three: type the code.
 *
 * Not a poor relation of the scanner. In the rain, at night, with a cracked
 * lens or a driver whose phone has died, this is the tier that works — so it
 * is a first-class button on the header, not something buried behind a failed
 * camera.
 *
 * The input is uppercase, tabular, and large: a short code is read aloud
 * across a car window more often than it is read off a screen.
 */

export interface ShortCodeEntryProps {
  onSubmit: (code: string) => void;
  onClose: () => void;
  busy: boolean;
  error: string | null;
}

export function ShortCodeEntry({
  onSubmit,
  onClose,
  busy,
  error,
}: ShortCodeEntryProps): React.JSX.Element {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const valid = looksLikeShortCode(code.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      data-testid="short-code-entry"
    >
      <button
        type="button"
        aria-label={t('action.close')}
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) onSubmit(code.trim().toUpperCase());
        }}
        className="relative flex w-full max-w-sm flex-col gap-4 rounded-2xl border-2 border-line bg-surface-raised p-6 shadow-2xl"
      >
        <h2 className="text-xl font-extrabold text-ink">{t('shortCode.title')}</h2>

        <input
          data-testid="short-code-input"
          value={code}
          onChange={(event) => {
            setCode(event.target.value.toUpperCase());
          }}
          maxLength={SHORT_CODE_LENGTH}
          autoFocus
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          aria-label={t('shortCode.title')}
          placeholder={'•'.repeat(SHORT_CODE_LENGTH)}
          className="rounded-xl border-2 border-line bg-surface px-4 py-4 text-center text-3xl font-extrabold tracking-[0.3em] tabular-nums text-ink"
        />

        {error ? (
          <p role="alert" data-testid="short-code-error" className="text-sm font-bold text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border-2 border-line px-4 py-3 font-bold text-ink"
          >
            {t('action.cancel')}
          </button>
          <button
            type="submit"
            data-testid="short-code-submit"
            disabled={!valid || busy}
            className="flex-1 rounded-xl bg-accent px-4 py-3 font-extrabold text-accent-ink disabled:opacity-50"
          >
            {busy ? '…' : t('action.checkIn')}
          </button>
        </div>
      </form>
    </div>
  );
}
