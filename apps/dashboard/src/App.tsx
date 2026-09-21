import { LOCALES, type Locale } from '@laqum/shared';
import { useTranslation } from 'react-i18next';

/**
 * Phase 0 placeholder. It exists to prove the toolchain end to end: React,
 * Tailwind v4, and Amharic/English i18n. The lot grid, the scanner and the
 * slot drawer are Phase 3.
 */
export function App(): React.JSX.Element {
  const { t, i18n } = useTranslation();

  const switchTo = (locale: Locale): void => {
    void i18n.changeLanguage(locale);
  };

  return (
    <main className="min-h-screen bg-slate-50 p-6 text-slate-900">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{t('app.name')}</h1>
          <p className="text-slate-600">{t('app.tagline')}</p>
        </div>

        <nav aria-label={t('common.language')} className="flex gap-2">
          {LOCALES.map((locale) => (
            <button
              key={locale}
              type="button"
              onClick={() => {
                switchTo(locale);
              }}
              aria-current={i18n.resolvedLanguage === locale}
              className={`rounded-lg px-4 py-2 text-sm font-medium ${
                i18n.resolvedLanguage === locale
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-700 ring-1 ring-slate-300'
              }`}
            >
              {locale.toUpperCase()}
            </button>
          ))}
        </nav>
      </header>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">{t('app.attendantConsole')}</h2>
        <p className="mt-1 text-slate-600">{t('common.phase')}</p>
      </section>
    </main>
  );
}
