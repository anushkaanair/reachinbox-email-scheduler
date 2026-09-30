import { Check, Download, Filter, RefreshCw, Sparkles, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import type { EmailTab } from '@ri/shared';
import { exportUrl } from '@/api/campaigns';
import { EmailList } from '@/components/email/EmailList';
import { SearchBar } from '@/components/email/SearchBar';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { useEmails } from '@/hooks/useEmails';
import { useDebounced, useEmailSearch } from '@/hooks/useIntegrations';
import { cn } from '@/lib/cn';

const nf = new Intl.NumberFormat();
const iconBtn = 'grid size-10 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-neutral-soft hover:text-ink disabled:opacity-60';

type Outcome = 'SENT' | 'FAILED' | undefined;

/** Shared page for both tabs (Scheduled / Sent): search, filter, refresh, then the rows. */
export function EmailListPage({ tab }: { tab: EmailTab }) {
  // The query lives in the URL (?q=) so a search survives refresh and can be shared.
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const legacyOpen = params.get('email'); // older links opened a side drawer; the email is a page now
  const setQ = (v: string) =>
    setParams((p) => { const n = new URLSearchParams(p); if (v) n.set('q', v); else n.delete('q'); return n; }, { replace: true });
  const debounced = useDebounced(q);
  const searching = debounced.trim().length > 0;

  const [starred, setStarred] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(undefined);
  const [archived, setArchived] = useState(false);
  const filters = useMemo(() => ({ starred: starred || undefined, outcome, archived: archived || undefined }), [starred, outcome, archived]);
  const active = (starred ? 1 : 0) + (outcome ? 1 : 0) + (archived ? 1 : 0);

  const list = useEmails(tab, filters);
  const search = useEmailSearch(debounced, tab);

  const searchRows = useMemo(
    () => (search.data?.items ?? []).filter((r) => (!starred || r.starred) && (!outcome || r.status === outcome) && r.archived === archived),
    [search.data, starred, outcome, archived],
  );

  if (legacyOpen) return <Navigate to={`/email/${legacyOpen}`} replace />;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="sr-only">{tab === 'scheduled' ? 'Scheduled emails' : 'Sent emails'}</h1>
      <div className="mb-3 flex items-center gap-2">
        <SearchBar value={q} onChange={setQ} loading={search.isFetching} />
        <Menu
          trigger={({ toggle }) => (
            <button type="button" onClick={toggle} aria-haspopup="menu" aria-label={active ? `Filter (${active} active)` : 'Filter'} className={cn(iconBtn, active > 0 && 'bg-brand-50 text-brand-700')}>
              <Filter className="size-[18px]" aria-hidden />
            </button>
          )}
        >
          <p className="px-4 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">Filter</p>
          <MenuItem onSelect={() => setStarred((s) => !s)} icon={starred ? <Check className="size-4 text-brand-700" aria-hidden /> : <span className="size-4" />}>
            Starred only
          </MenuItem>
          {tab === 'sent' && (
            <MenuItem onSelect={() => setArchived((a) => !a)} icon={archived ? <Check className="size-4 text-brand-700" aria-hidden /> : <span className="size-4" />}>
              Archived
            </MenuItem>
          )}
          {tab === 'sent' &&
            (['SENT', 'FAILED'] as const).map((o) => (
              <MenuItem key={o} onSelect={() => setOutcome((cur) => (cur === o ? undefined : o))} icon={outcome === o ? <Check className="size-4 text-brand-700" aria-hidden /> : <span className="size-4" />}>
                {o === 'SENT' ? 'Delivered only' : 'Failed only'}
              </MenuItem>
            ))}
          {active > 0 && (
            <MenuItem onSelect={() => { setStarred(false); setOutcome(undefined); setArchived(false); }} icon={<span className="size-4" />}>
              Clear filters
            </MenuItem>
          )}
        </Menu>
        <button
          type="button"
          className={iconBtn}
          onClick={() => void (searching ? search.refetch() : list.refetch())}
          disabled={list.isFetching}
          aria-label="Refresh"
        >
          <RefreshCw className={cn('size-[18px]', list.isFetching && !searching && 'animate-spin')} aria-hidden />
        </button>
        <a href={exportUrl({ tab })} download className={iconBtn} aria-label={`Export ${tab === 'sent' ? 'sent and failed' : 'scheduled'} emails as CSV`}>
          <Download className="size-[18px]" aria-hidden />
        </a>
      </div>

      {searching ? (
        <>
          <p className="mb-2 flex items-center gap-1.5 px-3 text-xs text-muted" aria-live="polite">
            {search.data && !search.isPlaceholderData ? (
              <>
                {search.data.approximate ? <Sparkles className="size-3.5 text-accent" aria-hidden /> : <Zap className="size-3.5 text-warn" aria-hidden />}
                {nf.format(search.data.total)} {search.data.approximate ? 'approximate ' : ''}result{search.data.total === 1 ? '' : 's'} for “{debounced}” · {search.data.tookMs} ms · Elasticsearch
              </>
            ) : (
              'Searching…'
            )}
          </p>
          <EmailList
            variant={tab}
            rows={searchRows}
            isLoading={search.isPending}
            error={search.error}
            onRetry={() => void search.refetch()}
            empty={{ title: `No matches for “${debounced}”`, description: 'Try part of an address, a word from the subject, or the body.' }}
          />
        </>
      ) : (
        <EmailList
          variant={tab}
          rows={list.rows}
          isLoading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          empty={active > 0 ? { title: 'Nothing matches these filters', description: 'Clear the filter to see every email.' } : undefined}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
        />
      )}
    </div>
  );
}
