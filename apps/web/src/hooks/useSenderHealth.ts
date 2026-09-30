import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WarmupUpdate } from '@ri/shared';
import { fetchSenderHealth, resumeSender, updateWarmup } from '@/api/senders';
import { livePollInterval } from './useLiveEvents';

const KEY = ['senders', 'health'] as const;

export function useSenderHealth() {
  return useQuery({ queryKey: KEY, queryFn: fetchSenderHealth, refetchInterval: livePollInterval });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['senders'] });
    void qc.invalidateQueries({ queryKey: ['preflight'] });
  };
}

export function useResumeSender() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: resumeSender, onSettled: refresh });
}

export function useUpdateWarmup() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: WarmupUpdate }) => updateWarmup(id, body), onSettled: refresh });
}
