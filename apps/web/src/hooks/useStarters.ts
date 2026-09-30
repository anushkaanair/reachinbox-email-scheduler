import { useQuery } from '@tanstack/react-query';
import { fetchStarters } from '@/api/assistant';

/** Suggested prompts, tuned by the server to what needs attention right now. */
export function useStarters(enabled: boolean) {
  return useQuery({ queryKey: ['assistant', 'starters'], queryFn: fetchStarters, enabled, staleTime: 20_000, retry: false });
}

export const FALLBACK_STARTERS = ['Give me an overview', 'Which sender is closest to its limit?', 'How many emails failed today?', "What's next to send?", 'Show my campaigns'];
