import { ChevronDown, LogOut, PenSquare } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { useAuth, useLogout } from '@/hooks/useAuth';
import { cn } from '@/lib/cn';
import { HealthPill } from './HealthPill';
import { Logo } from './Logo';

/** Top header: user's name, email, avatar + logout (required by the brief). */
export function Header() {
  const { user } = useAuth();
  const logout = useLogout();
  const navigate = useNavigate();
  if (!user) return null;

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
      <div className="flex h-16 items-center justify-between gap-4 px-4 md:px-8">
        <Logo className="md:hidden" />
        <div className="hidden md:block">
          <HealthPill />
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" className="md:hidden" onClick={() => navigate('/compose')} aria-label="Compose">
            <PenSquare className="size-4" />
          </Button>
          <Menu
            trigger={({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-canvas"
              >
                <Avatar src={user.avatarUrl} name={user.name} />
                <span className="hidden text-left sm:block">
                  <span className="block text-sm font-semibold leading-tight">{user.name}</span>
                  <span className="block text-xs text-muted">{user.email}</span>
                </span>
                <ChevronDown className="size-4 text-muted" />
              </button>
            )}
          >
            <div className="border-b border-line px-4 py-3 sm:hidden">
              <p className="text-sm font-semibold">{user.name}</p>
              <p className="text-xs text-muted">{user.email}</p>
            </div>
            <MenuItem danger icon={<LogOut className="size-4" />} onSelect={() => logout.mutate()}>
              {logout.isPending ? 'Signing out…' : 'Log out'}
            </MenuItem>
          </Menu>
        </div>
      </div>
      {/* Mobile tabs (the sidebar is hidden below md). */}
      <nav className="flex gap-1 overflow-x-auto px-4 pb-2 md:hidden" aria-label="Mailboxes">
        {[
          ['/dashboard/scheduled', 'Scheduled'],
          ['/dashboard/sent', 'Sent'],
          ['/campaigns', 'Campaigns'],
          ['/analytics', 'Analytics'],
          ['/settings', 'Settings'],
        ].map(([to, label]) => (
          <NavLink
            key={to}
            to={to!}
            className={({ isActive }) =>
              cn(
                'rounded-lg px-3 py-1.5 text-sm font-medium',
                isActive ? 'bg-brand-50 text-brand-700' : 'text-muted',
              )
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
