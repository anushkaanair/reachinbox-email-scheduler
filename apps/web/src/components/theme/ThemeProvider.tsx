import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyTheme, readThemePref, resolveTheme, saveThemePref, type Theme, type ThemePref } from '@/lib/theme';

type ThemeCtx = { pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void };
const Ctx = createContext<ThemeCtx | null>(null);

const query = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

/** Holds the user's choice (light / dark / follow the system) and keeps <html data-theme> in sync. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readThemePref);
  const [systemDark, setSystemDark] = useState(() => query()?.matches ?? false);

  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const theme = resolveTheme(pref, systemDark);
  useEffect(() => applyTheme(theme), [theme]);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    saveThemePref(p);
  }, []);

  const value = useMemo(() => ({ pref, theme, setPref }), [pref, theme, setPref]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme must be used inside <ThemeProvider>');
  return v;
}
