import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Intro } from './components/Intro.js';
import { initI18n } from './i18n.js';
import { browserSession, planIntro, prefersReducedMotion } from './intro.js';
import { applyTheme, storedTheme } from './theme.js';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root is missing from index.html');
}

// Before React renders, so the attendant never sees a flash of the wrong
// theme — which on a sunlit tablet is a flash of an unreadable screen.
applyTheme(storedTheme());

// Once per PAGE LOAD, outside React: a realtime reconnect never re-runs this,
// and strict mode cannot decide it twice. Null when it has played this session.
const intro = planIntro(browserSession(), prefersReducedMotion());

// i18n is initialised before the first render so no component ever flashes a
// translation key.
void initI18n().then((i18n) => {
  // The page's accessible name and language follow the chosen language; the
  // intro is aria-hidden, so this is what a screen reader announces.
  const nameThePage = (): void => {
    document.title = `${i18n.t('app.name')} — ${i18n.t('app.attendantConsole')}`;
    document.documentElement.lang = i18n.language;
  };
  nameThePage();
  i18n.on('languageChanged', nameThePage);

  // The app and the intro mount together: sign-in and the connection start
  // at once, underneath it.
  createRoot(container).render(
    <StrictMode>
      <App />
      <Intro plan={intro} />
    </StrictMode>,
  );
});
