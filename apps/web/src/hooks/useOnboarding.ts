import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OnboardingUpdate } from '@ri/shared';
import { fetchOnboarding, updateOnboarding } from '@/api/onboarding';

export const ONBOARDING_KEY = ['onboarding'] as const;

/** Answers, tour state and the live setup checklist. Re-fetched often so ticks appear as the user makes progress. */
export function useOnboarding() {
  return useQuery({ queryKey: ONBOARDING_KEY, queryFn: fetchOnboarding, staleTime: 15_000 });
}

export function useUpdateOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OnboardingUpdate) => updateOnboarding(body),
    onSuccess: (data) => qc.setQueryData(ONBOARDING_KEY, data),
  });
}
