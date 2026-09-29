import { RefreshCw, Sparkles, Zap } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import type { EmailTab } from '@ri/shared';
import { EmailDetailDrawer } from '@/components/email/EmailDetailDrawer';
import { EmailTable, type TableRow } from '@/components/email/EmailTable';
import { SearchBar } from '@/components/email/SearchBar';
import { Button } from '@/components/ui/Button';
import { useEmails } from '@/hooks/useEmails';
import { useDebounced, useEmailSearch } from '@/hooks/useIntegrations';

const TITLES: Record<EmailTab, { title: string; subtitle: string }> = {
  scheduled: { title: 'Scheduled Emails', subtitle: 'Queued, throttled or currently sending.' },
  sent: { title: 'Sent Emails', subtitle: 'Delivered to Ethereal, or failed after all retries.' },
};

const nf = new Intl.NumberFormat();

/** Shared page shell for both tabs — Scheduled/Sent differ only by `tab`. */
export function EmailListPage({ tab }: { tab: EmailTab }) {
  // The query lives in the URL (?q=) so a search survives refresh and can be shared.
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const openId = params.get('email');
  const patch = (key: string, v: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v) next.set(key, v);
        else next.delete(key);
        return next;
      },
      { replace: key === 'q' },
    );
  const setQ = (v: string) => patch('q', v || null);
  const open = (row: TableRow) => patch('email', row.id);
  const debounced = useDebounced(q);
  const searching = debounced.trim().length > 0;

  const list = useEmails(tab);
  const search = useEmailSearch(debounced, tab);
  const { title, subtitle } = TITLES[tab];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-sm text-muted">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <SearchBar value={q} onChange={setQ} loading={search.isFetching} />
          <Button
            variant="secondary"
            size="sm"
            className="h-9"
            onClick={() => void (searching ? search.refetch() : list.refetch())}
            disabled={list.isFetching}
            aria-label="Refresh"
          >
            <RefreshCw className={list.isFetching && !searching ? 'size-4 animate-spin' : 'size-4'} />
          </Button>
        </div>
      </div>

      {searching ? (
        <>
          <p className="mb-2 flex items-center gap-1.5 text-xs text-muted" aria-live="polite">
            {search.data && !search.isPlaceholderData ? (
              <>
                {search.data.approximate ? (
                  <Sparkles className="size-3.5 text-violet-500" aria-hidden />
                ) : (
                  <Zap className="size-3.5 text-amber-500" aria-hidden />
                )}
                {nf.format(search.data.total)} {search.data.approximate ? 'approximate ' : ''}
                result{search.data.total === 1 ? '' : 's'} for “{debounced}” · {search.data.tookMs} ms · Elasticsearch
              </>
            ) : (
              'Searching…'
            )}
          </p>
          <EmailTable
            variant={tab}
            rows={search.data?.items ?? []}
            isLoading={search.isPending}
            error={search.error}
            onRetry={() => void search.refetch()}
            onRowClick={open}
            empty={{ title: `No matches for “${debounced}”`, description: 'Try part of an address, a word from the subject, or the body.' }}
          />
        </>
      ) : (
        <EmailTable
          variant={tab}
          rows={list.rows}
          isLoading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowClick={open}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
        />
      )}
      <EmailDetailDrawer emailId={openId} onClose={() => patch('email', null)} />
    </div>
  );
}
