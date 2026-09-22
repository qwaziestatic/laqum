/**
 * Theme selection.
 *
 * Three states, not two: 'light', 'dark' and 'system'. An attendant who has
 * not chosen should follow the tablet — which in a kiosk deployment is often
 * scheduled to flip at dusk, exactly when the lot needs it.
 *
 * The stored choice is read synchronously in main.tsx before React renders, so
 * there is no flash of the wrong theme.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'laqum:theme';

export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // Private mode, or storage disabled by policy. Not a reason to fail.
  }
  return 'system';
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  const resolved =
    choice === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : choice;

  root.dataset['theme'] = resolved;
  // Tells the browser to render form controls and scrollbars to match.
  root.style.colorScheme = resolved;

  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // As above: a theme that does not persist is better than a crash.
  }
}
