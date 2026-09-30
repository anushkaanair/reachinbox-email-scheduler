import { BarChart3, CalendarClock, Compass, Layers, ListChecks, Mailbox, Send, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { buttonClass } from '@/components/ui/Button';
import { useEmailCounts } from '@/hooks/useEmails';
import { useOnboarding } from '@/hooks/useOnboarding';
import { cn } from '@/lib/cn';
import { HealthPill } from './HealthPill';
import { Logo } from './Logo';
import { UserCard } from './UserCard';

type NavItem = { to: string; label: string; icon: LucideIcon; count?: number | string };

const link = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
    isActive ? 'bg-brand-50 font-semibold text-ink' : 'text-soft hover:bg-neutral-soft hover:text-ink',
  );

/** Left rail, following the Figma frames: logo, account card, outlined Compose, then CORE. Our extra pages sit below. */
export function Sidebar() {
  const navigate = useNavigate();
  const { data: counts } = useEmailCounts();
  const { data: setup } = useOnboarding();

  const core: NavItem[] = [
    { to: '/dashboard/scheduled', label: 'Scheduled', icon: CalendarClock, count: counts?.scheduled },
    { to: '/dashboard/sent', label: 'Sent', icon: Send, count: counts ? counts.sent + counts.failed : undefined },
  ];
  const more: NavItem[] = [
    {
      to: '/getting-started',
      label: 'Getting started',
      icon: Compass,
      // The badge goes away once the core setup is done; the page stays reachable.
      count: setup && !setup.progress.complete ? `${setup.progress.done}/${setup.progress.total}` : undefined,
    },
    { to: '/campaigns', label: 'Campaigns', icon: Layers },
    { to: '/lead-lists', label: 'Lead lists', icon: ListChecks },
    { to: '/analytics', label: 'Analytics', icon: BarChart3 },
    { to: '/senders', label: 'Email accounts', icon: Mailbox },
  ];

  const render = ({ to, label, icon: Icon, count }: NavItem) => (
    <NavLink key={to} to={to} data-tour={to} className={link}>
      <Icon className="size-[18px]" aria-hidden />
      <span className="flex-1">{label}</span>
      {count !== undefined && <span className="text-xs tabular-nums text-muted">{count}</span>}
    </NavLink>
  );

  return (
    <aside className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-surface px-4 py-5 md:flex">
      <div className="px-1">
        <Logo />
      </div>
      <UserCard />
      <button
        type="button"
        data-tour="compose"
        onClick={() => navigate('/compose')}
        className={buttonClass('secondary', 'md', 'w-full rounded-full border-brand-600 bg-surface text-brand-600 hover:bg-brand-50')}
      >
        Compose
      </button>

      <nav aria-label="Mailboxes" className="flex flex-col gap-1">
        <p className="px-3 pb-1 text-xs tracking-wider text-muted uppercase">Core</p>
        {core.map(render)}
      </nav>
      <nav aria-label="More" className="flex flex-col gap-1">
        <p className="px-3 pb-1 text-xs tracking-wider text-muted uppercase">More</p>
        {more.map(render)}
      </nav>

      <div className="mt-auto flex flex-col gap-2">
        <div className="px-1">
          <HealthPill />
        </div>
        <nav aria-label="Account" className="border-t border-line pt-2">
          <NavLink to="/settings" data-tour="/settings" className={link}>
            <Settings className="size-[18px]" aria-hidden />
            Settings
          </NavLink>
        </nav>
      </div>
    </aside>
  );
}
