import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initI18n } from './i18n.js';
import { applyTheme, storedTheme } from './theme.js';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root is missing from index.html');
}

// Before React renders, so the attendant never sees a flash of the wrong
// theme — which on a sunlit tablet is a flash of an unreadable screen.
applyTheme(storedTheme());

// i18n is initialised before the first render so no component ever flashes a
// translation key.
void initI18n().then(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
