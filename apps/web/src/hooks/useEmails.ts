import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EmailTab } from '@ri/shared';
import { archiveEmail, fetchEmailCounts, listEmails, starEmail, type EmailFilters } from '@/api/emails';
import { livePollInterval } from './useLiveEvents';

export const emailKeys = {
  all: ['emails'] as const,
  list: (tab: EmailTab, f: EmailFilters = {}) => ['emails', 'list', tab, f] as const,
  counts: ['emails', 'counts'] as const,
};

export function useEmails(tab: EmailTab, filters: EmailFilters = {}) {
  const q = useInfiniteQuery({
    queryKey: emailKeys.list(tab, filters),
    queryFn: ({ pageParam, signal }) => listEmails(tab, pageParam, signal, filters),
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

/** Star / unstar. The UI flips instantly; a failure puts it back and refetches. */
export function useStar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, starred }: { id: string; starred: boolean }) => starEmail(id, starred),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['emails'] }),
  });
}

/** Archive / unarchive a finished email. */
export function useArchive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => archiveEmail(id, archived),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['emails'] }),
  });
}
