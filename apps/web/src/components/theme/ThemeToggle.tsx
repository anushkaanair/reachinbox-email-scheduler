import { Check, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { useTheme } from './ThemeProvider';
import type { ThemePref } from '@/lib/theme';

export const THEME_OPTIONS: { value: ThemePref; label: string; icon: LucideIcon }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Header control: shows the active theme's icon; the menu switches between Light, Dark and System. */
export function ThemeToggle() {
  const { pref, theme, setPref } = useTheme();
  const Icon = theme === 'dark' ? Moon : Sun;
  return (
    <Menu
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Theme: ${pref === 'system' ? `system (${theme})` : pref}. Change theme`}
          className="grid size-9 place-items-center rounded-lg border border-line text-muted transition-colors hover:bg-neutral-soft hover:text-ink"
        >
          <Icon className="size-4" aria-hidden />
        </button>
      )}
    >
      <p className="px-4 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">Theme</p>
      {THEME_OPTIONS.map(({ value, label, icon: I }) => (
        <MenuItem key={value} onSelect={() => setPref(value)} icon={<I className="size-4 text-muted" aria-hidden />}>
          <span className="flex-1">{label}</span>
          {pref === value && <Check className="size-4 text-brand-700" aria-label="Selected" />}
        </MenuItem>
      ))}
    </Menu>
  );
}
