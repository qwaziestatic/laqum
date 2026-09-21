import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initI18n } from './i18n.js';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root is missing from index.html');
}

// i18n is initialised before the first render so no component ever flashes a
// translation key.
void initI18n().then(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
