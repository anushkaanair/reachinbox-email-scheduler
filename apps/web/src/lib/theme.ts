export type ThemePref = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

const KEY = 'ri-theme';

/** Storage can be blocked (private windows, strict settings) — the app must work without it. */
export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function saveThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
}

export const resolveTheme = (pref: ThemePref, systemDark: boolean): Theme => (pref === 'system' ? (systemDark ? 'dark' : 'light') : pref);

export function applyTheme(theme: Theme): void {
  const el = document.documentElement;
  el.dataset.theme = theme;
  el.style.colorScheme = theme;
}
