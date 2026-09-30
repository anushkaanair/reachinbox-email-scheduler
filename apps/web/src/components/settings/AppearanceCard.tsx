import { Check, Palette } from 'lucide-react';
import { THEME_OPTIONS } from '@/components/theme/ThemeToggle';
import { useTheme } from '@/components/theme/ThemeProvider';
import { cn } from '@/lib/cn';
import type { ThemePref } from '@/lib/theme';

/** A tiny drawn preview of the app in a theme, so people choose by looking, not by name. */
function Preview({ kind }: { kind: 'light' | 'dark' }) {
  const dark = kind === 'dark';
  return (
    <span
      aria-hidden
      className="relative block h-20 w-full overflow-hidden rounded-lg border"
      style={{
        background: dark
          ? 'radial-gradient(120px 60px at 50% -20px, rgba(86,72,232,.55), transparent 70%), #05060d'
          : 'radial-gradient(120px 50px at 50% -20px, rgba(11,154,91,.10), transparent 70%), #f7f8fa',
        borderColor: dark ? 'rgba(255,255,255,.12)' : '#e5e7eb',
      }}
    >
      {dark && (
        <>
          <i className="absolute top-3 left-5 size-[2px] rounded-full bg-white" />
          <i className="absolute top-6 right-8 size-[2px] rounded-full bg-white/80" />
          <i className="absolute right-16 bottom-4 size-[2px] rounded-full bg-white/70" />
          <i className="absolute bottom-6 left-16 size-[2px] rounded-full bg-white/60" />
        </>
      )}
      <span className="absolute inset-y-0 left-0 w-6" style={{ background: dark ? 'rgba(255,255,255,.06)' : '#fff', borderRight: `1px solid ${dark ? 'rgba(255,255,255,.1)' : '#e5e7eb'}` }} />
      <span className="absolute top-3 right-3 left-9 h-2 rounded" style={{ background: dark ? 'rgba(255,255,255,.14)' : '#dfe3e8' }} />
      <span className="absolute top-8 right-3 left-9 h-5 rounded" style={{ background: dark ? 'rgba(18,20,44,.8)' : '#fff', border: `1px solid ${dark ? 'rgba(255,255,255,.1)' : '#e5e7eb'}` }} />
      <span className="absolute right-3 bottom-3 h-2.5 w-10 rounded-full" style={{ background: dark ? '#22c477' : '#0b9a5b' }} />
    </span>
  );
}

export function AppearanceCard() {
  const { pref, setPref, theme } = useTheme();
  return (
    <section className="rounded-xl border border-line bg-surface" aria-labelledby="appearance-title">
      <header className="flex items-start gap-4 border-b border-line p-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
          <Palette className="size-6" aria-hidden />
        </span>
        <div>
          <h2 id="appearance-title" className="text-base font-semibold">Appearance</h2>
          <p className="mt-0.5 text-sm text-muted">
            Choose how ReachInbox looks. “System” follows your device{pref === 'system' ? ` (currently ${theme})` : ''}.
          </p>
        </div>
      </header>
      <div role="radiogroup" aria-label="Theme" className="grid gap-3 p-5 sm:grid-cols-3">
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
          const selected = pref === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setPref(value as ThemePref)}
              className={cn(
                'flex flex-col gap-2 rounded-xl border p-2.5 text-left transition-colors',
                selected ? 'border-brand-500 bg-brand-50' : 'border-line hover:border-faint',
              )}
            >
              {value === 'system' ? (
                <span aria-hidden className="grid h-20 grid-cols-2 overflow-hidden rounded-lg border border-line">
                  <span className="[&>span]:rounded-none [&>span]:border-0"><Preview kind="light" /></span>
                  <span className="[&>span]:rounded-none [&>span]:border-0"><Preview kind="dark" /></span>
                </span>
              ) : (
                <Preview kind={value} />
              )}
              <span className="flex items-center gap-2 px-0.5 text-sm font-medium">
                <Icon className="size-4 text-muted" aria-hidden />
                {label}
                {selected && <Check className="ml-auto size-4 text-brand-700" aria-label="Selected" />}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
