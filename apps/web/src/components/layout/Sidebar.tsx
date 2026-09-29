import { BarChart3, CalendarClock, Layers, PenSquare, Send, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { useEmailCounts } from '@/hooks/useEmails';
import { cn } from '@/lib/cn';
import { Logo } from './Logo';

type NavItem = { to: string; label: string; icon: LucideIcon; count?: number };

export function Sidebar() {
  const navigate = useNavigate();
  const { data: counts } = useEmailCounts();

  const items: NavItem[] = [
    {
      to: '/dashboard/scheduled',
      label: 'Scheduled',
      icon: CalendarClock,
      count: counts?.scheduled,
    },
    {
      to: '/dashboard/sent',
      label: 'Sent',
      icon: Send,
      count: counts ? counts.sent + counts.failed : undefined,
    },
  ];
  const insights: NavItem[] = [
    { to: '/campaigns', label: 'Campaigns', icon: Layers },
    { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  ];

  const renderItem = ({ to, label, icon: Icon, count }: NavItem) => (
    <NavLink
      key={to}
      to={to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          isActive ? 'bg-brand-50 text-brand-700' : 'text-muted hover:bg-canvas hover:text-ink',
        )
      }
    >
      <Icon className="size-4" aria-hidden />
      <span className="flex-1">{label}</span>
      {count !== undefined && <span className="text-xs tabular-nums">{count}</span>}
    </NavLink>
  );

  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="px-5 py-5">
        <Logo />
      </div>
      <div className="px-4">
        <Button size="lg" className="w-full" onClick={() => navigate('/compose')}>
          <PenSquare className="size-4" />
          Compose
        </Button>
      </div>
      <nav aria-label="Mailboxes" className="mt-6 flex flex-col gap-1 px-3">
        <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted">Core</p>
        {items.map(renderItem)}
        <p className="px-3 pt-4 pb-1 text-xs font-semibold tracking-wider text-muted uppercase">
          Insights
        </p>
        {insights.map(renderItem)}
      </nav>
      <nav aria-label="Account" className="mt-auto border-t border-line px-3 py-3">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive ? 'bg-brand-50 text-brand-700' : 'text-muted hover:bg-canvas hover:text-ink',
            )
          }
        >
          <Settings className="size-4" aria-hidden />
          Settings
        </NavLink>
      </nav>
    </aside>
  );
}
