import { ExternalLink } from 'lucide-react';
import { Menu } from '@/components/ui/Menu';
import { useHealth } from '@/hooks/useInsights';
import { useLiveConnected } from '@/hooks/useLiveEvents';
import { cn } from '@/lib/cn';

const Dot = ({ ok }: { ok: boolean | undefined }) => (
  <span className={cn('size-2 rounded-full', ok === undefined ? 'bg-slate-300' : ok ? 'bg-brand-500' : 'bg-red-500')} aria-hidden />
);

/** Header pill: live-stream state + backing services, with a shortcut to the queue dashboard. */
export function HealthPill() {
  const { data, isError } = useHealth();
  const live = useLiveConnected();
  const healthy = data?.status === 'ok' && !isError;
  const label = isError ? 'API unreachable' : !data ? 'Checking…' : healthy ? (live ? 'Live' : 'Healthy') : 'Degraded';

  return (
    <Menu
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-2 rounded-full border border-line px-3 py-1 text-xs font-medium text-muted hover:bg-canvas"
        >
          <span className="relative flex size-2">
            {healthy && live && <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-500 opacity-60" />}
            <span className={cn('relative inline-flex size-2 rounded-full', healthy ? 'bg-brand-500' : data || isError ? 'bg-red-500' : 'bg-slate-300')} />
          </span>
          {label}
        </button>
      )}
    >
      <div className="px-4 py-3 text-sm">
        <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">System</p>
        <ul className="flex flex-col gap-1.5">
          <li className="flex items-center gap-2"><Dot ok={data?.db} /> Postgres</li>
          <li className="flex items-center gap-2"><Dot ok={data?.redis} /> Redis · queues</li>
          <li className="flex items-center gap-2"><Dot ok={data?.elasticsearch} /> Elasticsearch · search</li>
          <li className="flex items-center gap-2"><Dot ok={live} /> Live updates</li>
        </ul>
      </div>
      <a
        href="/admin/queues"
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-sm text-brand-700 hover:bg-canvas"
      >
        Queue dashboard (Bull Board) <ExternalLink className="size-3.5" />
      </a>
    </Menu>
  );
}
