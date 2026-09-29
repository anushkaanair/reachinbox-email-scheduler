import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  campaignAction,
  emailAction,
  fetchAnalytics,
  fetchCampaigns,
  fetchEmailDetail,
  fetchHealth,
  type CampaignAction,
} from '@/api/insights';
import { livePollInterval } from './useLiveEvents';

export const insightKeys = {
  campaigns: ['campaigns'] as const,
  analytics: (h: number) => ['analytics', h] as const,
  detail: (id: string) => ['emails', 'detail', id] as const,
};

export function useCampaigns() {
  return useQuery({ queryKey: insightKeys.campaigns, queryFn: fetchCampaigns, refetchInterval: livePollInterval });
}

export function useAnalytics(hours: number) {
  return useQuery({ queryKey: insightKeys.analytics(hours), queryFn: () => fetchAnalytics(hours), refetchInterval: livePollInterval });
}

export function useEmailDetail(id: string | null) {
  return useQuery({ queryKey: insightKeys.detail(id ?? ''), queryFn: () => fetchEmailDetail(id!), enabled: Boolean(id) });
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 30_000, retry: false });
}

/** Every mutation refreshes everything email-shaped; live events usually got there first. */
function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    for (const key of [['emails'], ['campaigns'], ['analytics']]) void qc.invalidateQueries({ queryKey: key });
  };
}

export function useCampaignAction() {
  const refresh = useInvalidateAll();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: CampaignAction }) => campaignAction(id, action),
    onSettled: refresh,
  });
}

export function useEmailAction() {
  const refresh = useInvalidateAll();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'retry' | 'cancel' }) => emailAction(id, action),
    onSettled: refresh,
  });
}
