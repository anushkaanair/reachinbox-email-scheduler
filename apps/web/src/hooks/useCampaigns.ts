import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CreateCampaignInput } from '@ri/shared';
import { createCampaign, fetchSenders } from '@/api/campaigns';
import { emailKeys } from './useEmails';

export function useSenders() {
  return useQuery({ queryKey: ['senders'], queryFn: fetchSenders, staleTime: 30_000 });
}

/**
 * One Idempotency-Key per compose session: double-clicks and network retries of the same
 * submission can never create two campaigns. A fresh key is minted only after success.
 */
export function useScheduleCampaign() {
  const qc = useQueryClient();
  const [key, setKey] = useState(() => crypto.randomUUID());
  return useMutation({
    mutationFn: (input: CreateCampaignInput) => createCampaign(input, key),
    onSuccess: () => {
      setKey(crypto.randomUUID());
      void qc.invalidateQueries({ queryKey: emailKeys.all });
      void qc.invalidateQueries({ queryKey: ['senders'] });
    },
  });
}
