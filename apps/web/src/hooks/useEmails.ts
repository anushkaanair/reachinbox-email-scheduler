import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { EmailTab } from '@ri/shared';
import { fetchEmailCounts, listEmails } from '@/api/emails';
import { livePollInterval } from './useLiveEvents';

export const emailKeys = {
  all: ['emails'] as const,
  list: (tab: EmailTab) => ['emails', 'list', tab] as const,
  counts: ['emails', 'counts'] as const,
};

export function useEmails(tab: EmailTab) {
  const q = useInfiniteQuery({
    queryKey: emailKeys.list(tab),
    queryFn: ({ pageParam, signal }) => listEmails(tab, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Live events drive refreshes; polling is only the safety net (slower while SSE is up).
    refetchInterval: livePollInterval,
  });
  return { ...q, rows: q.data?.pages.flatMap((p) => p.items) ?? [] };
}

export function useEmailCounts() {
  return useQuery({ queryKey: emailKeys.counts, queryFn: fetchEmailCounts, refetchInterval: livePollInterval });
}
