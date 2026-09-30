import { AlertTriangle, Flame, Mailbox, MoreHorizontal, Plus, Search, Tag, Trash2, Upload, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PROVIDER_LABEL, type SenderDetail } from '@ri/shared';
import { AccountDrawer } from '@/components/accounts/AccountDrawer';
import { ConnectModal } from '@/components/accounts/ConnectModal';
import { ImportModal } from '@/components/accounts/ImportModal';
import { STATUS } from '@/components/accounts/parts';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Field';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/Skeleton';
import { useBulkAccounts, useSenderHealth, useUpdateWarmup } from '@/hooks/useSenderHealth';
import { accountSummary, allTags, filterAccounts, FILTERS, type FilterKey } from '@/lib/accounts';
import { cn } from '@/lib/cn';

const nf = new Intl.NumberFormat();
const box = 'size-4 shrink-0 cursor-pointer rounded border-line accent-brand-600 focus-visible:ring-2 focus-visible:ring-brand-100';

const dailyCap = (s: SenderDetail) => {
  const caps = [s.warmup.capToday, s.dailyLimit].filter((c): c is number => c !== null);
  return caps.length ? Math.min(...caps) : null;
};

function Row({ s, selected, onSelect, onOpen, onRemove }: { s: SenderDetail; selected: boolean; onSelect: (on: boolean) => void; onOpen: () => void; onRemove: () => void }) {
  const warm = useUpdateWarmup();
  const cap = dailyCap(s);
  const st = STATUS[s.health.status];
  return (
    <tr className={cn('border-t border-line align-middle', selected && 'bg-brand-50/60')}>
      <td className="w-10 py-3 pl-4">
        <input type="checkbox" className={box} checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${s.email}`} />
      </td>
      <td className="min-w-64 px-3 py-3">
        <button type="button" onClick={onOpen} className="block max-w-full text-left">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium hover:underline">{s.email}</span>
            {s.attention === 'error' && <Badge tone="danger">Needs attention</Badge>}
            {s.attention === 'paused' && <Badge tone="danger">Paused</Badge>}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {PROVIDER_LABEL[s.provider]}
            {s.tags.map((t) => (
              <span key={t} className="rounded bg-neutral-soft px-1.5 py-0.5 text-[11px] text-soft">
                {t}
              </span>
            ))}
          </span>
        </button>
      </td>
      <td className="px-3 py-3 text-sm tabular-nums">
        {nf.format(s.sentToday)} <span className="text-muted">/ {cap ?? '∞'}</span>
      </td>
      <td className="px-3 py-3 text-sm tabular-nums">{s.bouncedToday}</td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            className={box}
            checked={s.warmup.enabled}
            disabled={warm.isPending}
            aria-label={`Warm-up for ${s.email}`}
            onChange={(e) => warm.mutate({ id: s.id, body: { enabled: e.target.checked } }, { onSuccess: () => toast(e.target.checked ? 'Warm-up on' : 'Warm-up off') })}
          />
          <span className="text-xs text-muted">{!s.warmup.enabled ? 'Off' : s.warmup.complete ? 'Complete' : `Day ${s.warmup.day}`}</span>
          {s.warmup.enabled && !s.warmup.complete && <Flame className="size-3.5 text-warn" aria-hidden />}
        </div>
      </td>
      <td className="px-3 py-3">
        <Badge tone={st.tone}>
          {s.health.score} · {st.label}
        </Badge>
      </td>
      <td className="w-12 py-3 pr-4 text-right">
        <Menu
          trigger={({ toggle }) => (
            <button type="button" onClick={toggle} aria-label={`Actions for ${s.email}`} aria-haspopup="menu" className="rounded-md p-1.5 text-muted hover:bg-neutral-soft hover:text-ink">
              <MoreHorizontal className="size-4" />
            </button>
          )}
        >
          <MenuItem onSelect={onOpen}>Open details</MenuItem>
          <MenuItem onSelect={onRemove} danger icon={<Trash2 className="size-4" />}>
            Remove account
          </MenuItem>
        </Menu>
      </td>
    </tr>
  );
}

function BulkBar({ ids, onClear, onRemove }: { ids: string[]; onClear: () => void; onRemove: () => void }) {
  const bulk = useBulkAccounts();
  const [tag, setTag] = useState('');
  const [limit, setLimit] = useState('');
  const run = (body: Parameters<typeof bulk.mutate>[0], msg: string) =>
    bulk.mutate(body, {
      onSuccess: (r) => {
        toast.success(`${msg} · ${r.updated} account${r.updated === 1 ? '' : 's'}`);
        for (const k of r.skipped) toast.error(`${k.email}: ${k.reason}`);
      },
      onError: (e) => toast.error(e.message),
    });
  return (
    <div role="region" aria-label="Bulk actions" className="mb-3 flex flex-wrap items-end gap-3 rounded-xl border border-brand-100 bg-brand-50 px-4 py-3">
      <p className="mr-auto text-sm font-medium">{ids.length} selected</p>
      <Button size="sm" variant="secondary" loading={bulk.isPending} onClick={() => run({ action: 'enable_warmup', ids }, 'Warm-up on')}>
        Enable warm-up
      </Button>
      <Button size="sm" variant="secondary" loading={bulk.isPending} onClick={() => run({ action: 'pause_warmup', ids }, 'Warm-up off')}>
        Pause warm-up
      </Button>
      <form
        className="flex items-end gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (tag.trim()) run({ action: 'add_tags', ids, tags: tag.split(',').map((t) => t.trim()).filter(Boolean) }, 'Tagged');
          setTag('');
        }}
      >
        <Input aria-label="Tag to add" placeholder="Add tag…" value={tag} onChange={(e) => setTag(e.target.value)} className="h-8 w-32" />
        <Button size="sm" variant="secondary" type="submit" disabled={!tag.trim()}>
          <Tag className="size-4" /> Add
        </Button>
      </form>
      <form
        className="flex items-end gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(limit);
          if (Number.isInteger(n) && n >= 1) run({ action: 'edit_settings', ids, settings: { dailyLimit: n } }, 'Daily limit set');
          setLimit('');
        }}
      >
        <Input aria-label="Daily limit for selected accounts" type="number" min={1} placeholder="Daily limit" value={limit} onChange={(e) => setLimit(e.target.value)} className="h-8 w-28" />
        <Button size="sm" variant="secondary" type="submit" disabled={!limit}>
          Set
        </Button>
      </form>
      <Button size="sm" variant="ghost" className="text-danger" onClick={onRemove}>
        <Trash2 className="size-4" /> Remove
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear} aria-label="Clear selection">
        <X className="size-4" />
      </Button>
    </div>
  );
}

/** Email Accounts: connect, monitor and configure every sending account. */
export function SendersPage() {
  const { data, isPending, error, refetch } = useSenderHealth();
  const bulk = useBulkAccounts();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<ReadonlySet<FilterKey>>(new Set());
  const [tagFilter, setTagFilter] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [connect, setConnect] = useState(false);
  const [csv, setCsv] = useState(false);
  const [removing, setRemoving] = useState<string[] | null>(null);

  const list = useMemo(() => data ?? [], [data]);
  const shown = useMemo(() => filterAccounts(list, filters, query, tagFilter), [list, filters, query, tagFilter]);
  const sum = accountSummary(list);
  const tags = allTags(list);
  const opened = list.find((s) => s.id === openId) ?? null;
  const selectedShown = shown.filter((s) => selected.has(s.id));
  const allOn = shown.length > 0 && selectedShown.length === shown.length;

  const toggle = <T,>(set: ReadonlySet<T>, v: T) => {
    const n = new Set(set);
    if (!n.delete(v)) n.add(v);
    return n;
  };

  const confirmRemove = () =>
    removing &&
    bulk.mutate(
      { action: 'delete', ids: removing },
      {
        onSuccess: (r) => {
          toast.success(`Removed ${r.updated} account${r.updated === 1 ? '' : 's'}`);
          for (const k of r.skipped) toast.error(`${k.email}: ${k.reason}`);
          setSelected(new Set());
          setRemoving(null);
        },
        onError: (e) => toast.error(e.message),
      },
    );

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Email accounts</h1>
          <p className="text-sm text-muted">Connect sending accounts, watch their health, and set limits, warm-up and signatures. Updates live.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setCsv(true)}>
            <Upload className="size-4" /> Upload CSV
          </Button>
          <Button onClick={() => setConnect(true)}>
            <Plus className="size-4" /> Connect account
          </Button>
        </div>
      </div>

      {error ? (
        <EmptyState tone="danger" icon={AlertTriangle} title="Couldn’t load email accounts" description={error.message} action={<Button variant="secondary" onClick={() => void refetch()}>Try again</Button>} />
      ) : isPending ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState
            icon={Mailbox}
            title="No sending accounts yet"
            description="Connect a Google, Microsoft or custom SMTP account, or upload many at once from a CSV. We check the login before saving."
            action={
              <div className="flex gap-2">
                <Button onClick={() => setConnect(true)}>
                  <Plus className="size-4" /> Connect account
                </Button>
                <Button variant="secondary" onClick={() => setCsv(true)}>
                  <Upload className="size-4" /> Upload CSV
                </Button>
              </div>
            }
          />
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Summary">
            <Badge tone="neutral" dot={false}>
              {sum.total} account{sum.total === 1 ? '' : 's'}
            </Badge>
            {sum.attention > 0 && <Badge tone="danger">{sum.attention} need{sum.attention === 1 ? 's' : ''} attention</Badge>}
            {sum.warming > 0 && <Badge tone="warning">{sum.warming} warming up</Badge>}
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <Input aria-label="Search accounts" placeholder="Search accounts or tags" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filters">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={filters.has(f.key)}
                  onClick={() => setFilters(toggle(filters, f.key))}
                  className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', filters.has(f.key) ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-muted hover:text-ink')}
                >
                  {f.label}
                </button>
              ))}
              {tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={tagFilter.has(t)}
                  onClick={() => setTagFilter(toggle(tagFilter, t))}
                  className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', tagFilter.has(t) ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-muted hover:text-ink')}
                >
                  # {t}
                </button>
              ))}
            </div>
          </div>

          {selectedShown.length > 0 && <BulkBar ids={selectedShown.map((s) => s.id)} onClear={() => setSelected(new Set())} onRemove={() => setRemoving(selectedShown.map((s) => s.id))} />}

          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[46rem] text-left">
              <thead className="text-xs text-muted">
                <tr>
                  <th scope="col" className="w-10 py-3 pl-4">
                    <input
                      type="checkbox"
                      className={box}
                      checked={allOn}
                      onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((s) => s.id)) : new Set())}
                      aria-label="Select all shown accounts"
                    />
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">Account</th>
                  <th scope="col" className="px-3 py-3 font-medium">Sent today</th>
                  <th scope="col" className="px-3 py-3 font-medium">Bounced today</th>
                  <th scope="col" className="px-3 py-3 font-medium">Warm-up</th>
                  <th scope="col" className="px-3 py-3 font-medium">Health</th>
                  <th scope="col" className="py-3 pr-4"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <Row
                    key={s.id}
                    s={s}
                    selected={selected.has(s.id)}
                    onSelect={(on) => setSelected((cur) => { const n = new Set(cur); if (on) n.add(s.id); else n.delete(s.id); return n; })}
                    onOpen={() => setOpenId(s.id)}
                    onRemove={() => setRemoving([s.id])}
                  />
                ))}
              </tbody>
            </table>
            {shown.length === 0 && (
              <p className="px-4 py-10 text-center text-sm text-muted">
                No accounts match.{' '}
                <button type="button" className="text-brand-600 underline" onClick={() => { setFilters(new Set()); setTagFilter(new Set()); setQuery(''); }}>
                  Clear filters
                </button>
              </p>
            )}
          </div>
          <p className="mt-3 text-xs text-muted">
            “Sent today” counts campaign emails against the account’s daily limit or warm-up cap. Health is a heuristic from the last {list[0]!.healthWindowDays} days: failures, bounces and repeated errors lower it, and an account that keeps failing pauses itself.
          </p>
        </>
      )}

      <AccountDrawer account={opened} onClose={() => setOpenId(null)} />
      <ConnectModal open={connect} onClose={() => setConnect(false)} onCsv={() => setCsv(true)} />
      <ImportModal open={csv} onClose={() => setCsv(false)} />
      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.length ?? 0} account${removing?.length === 1 ? '' : 's'}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" loading={bulk.isPending} onClick={confirmRemove}>Remove</Button>
          </>
        }
      >
        <p className="text-sm text-soft">
          They stop sending and disappear from this list. Accounts that still have scheduled emails are kept until those are sent or cancelled. You can connect a removed address again later.
        </p>
      </Modal>
    </div>
  );
}
