import { Check, ChevronDown, LogOut, Sparkles } from 'lucide-react';
import { useAssistant } from '@/components/assistant/AssistantProvider';
import { THEME_OPTIONS } from '@/components/theme/ThemeToggle';
import { useTheme } from '@/components/theme/ThemeProvider';
import { Avatar } from '@/components/ui/Avatar';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { useAuth, useLogout } from '@/hooks/useAuth';

/** The account card at the top of the sidebar (Figma): avatar, name, email, and a menu with logout. */
export function UserCard() {
  const { user } = useAuth();
  const logout = useLogout();
  const assistant = useAssistant();
  const { pref, setPref } = useTheme();
  if (!user) return null;
  return (
    <Menu
      align="left"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex w-full items-center gap-3 rounded-xl bg-neutral-soft px-3 py-2.5 text-left transition-colors hover:bg-neutral-strong"
        >
          <Avatar src={user.avatarUrl} name={user.name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium leading-tight">{user.name}</span>
            <span className="block truncate text-xs text-muted">{user.email}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
        </button>
      )}
    >
      <MenuItem icon={<Sparkles className="size-4 text-accent" />} onSelect={() => assistant.open('palette')}>
        Ask Inbox
      </MenuItem>
      <p className="px-4 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">Theme</p>
      {THEME_OPTIONS.map(({ value, label, icon: I }) => (
        <MenuItem key={value} onSelect={() => setPref(value)} icon={<I className="size-4 text-muted" aria-hidden />}>
          <span className="flex-1">{label}</span>
          {pref === value && <Check className="size-4 text-brand-700" aria-label="Selected" />}
        </MenuItem>
      ))}
      <MenuItem danger icon={<LogOut className="size-4" />} onSelect={() => logout.mutate()}>
        {logout.isPending ? 'Signing out…' : 'Log out'}
      </MenuItem>
    </Menu>
  );
}
