import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { EmailTab } from '@ri/shared';
import { disconnectSlack, fetchSlackStatus, searchEmails, sendSlackTest } from '@/api/integrations';
import { ME_KEY } from './useAuth';

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useEmailSearch(q: string, tab: EmailTab) {
  const query = q.trim();
  return useQuery({
    queryKey: ['emails', 'search', tab, query],
    queryFn: ({ signal }) => searchEmails(query, tab, signal),
    enabled: query.length > 0,
    placeholderData: keepPreviousData, // no flicker between keystrokes
    staleTime: 5_000,
  });
}

const SLACK_KEY = ['slack'] as const;

export function useSlack() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: SLACK_KEY, queryFn: fetchSlackStatus });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: SLACK_KEY });
    void qc.invalidateQueries({ queryKey: ME_KEY });
  };
  const test = useMutation({ mutationFn: sendSlackTest, onSettled: refresh });
  const disconnect = useMutation({ mutationFn: disconnectSlack, onSuccess: refresh });
  return { status, test, disconnect };
}
