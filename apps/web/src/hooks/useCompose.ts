import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PreflightInput } from '@ri/shared';
import { preflight, retryFailed, testSend } from '@/api/campaigns';
import { addSuppressions, listSuppressions, removeSuppression } from '@/api/suppressions';

/** Read-only report + forecast for the composer. `key` stands in for the (large) email list. */
export function usePreflight(params: PreflightInput | null, key: string) {
  return useQuery({
    queryKey: ['preflight', key, params && { ...params, emails: params.emails.length }],
    queryFn: ({ signal }) => preflight(params!, signal),
    enabled: params !== null,
    placeholderData: keepPreviousData, // no flicker while the user edits a field
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export const useTestSend = () => useMutation({ mutationFn: testSend });

const SUPPRESSIONS = ['suppressions'] as const;

export function useSuppressions(q = '') {
  return useQuery({ queryKey: [...SUPPRESSIONS, q], queryFn: () => listSuppressions(q), placeholderData: keepPreviousData });
}

export function useAddSuppressions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: addSuppressions,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SUPPRESSIONS });
      void qc.invalidateQueries({ queryKey: ['preflight'] });
    },
  });
}

export function useRemoveSuppression() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: removeSuppression,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SUPPRESSIONS });
      void qc.invalidateQueries({ queryKey: ['preflight'] });
    },
  });
}

export function useRetryFailed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: retryFailed,
    onSettled: () => {
      for (const key of [['emails'], ['campaigns'], ['analytics']]) void qc.invalidateQueries({ queryKey: key });
    },
  });
}
