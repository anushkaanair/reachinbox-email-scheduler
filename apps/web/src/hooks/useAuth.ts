import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchMe, loginWithPassword, logout, signupWithPassword } from '@/api/auth';

export const ME_KEY = ['me'] as const;

export function useAuth() {
  const query = useQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 5 * 60_000 });
  return { user: query.data ?? null, isLoading: query.isPending, error: query.error };
}

export function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: logout,
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(ME_KEY, null);
      navigate('/login', { replace: true });
    },
  });
}

/** Email + password sign-in or sign-up. On success the session cookie is set, so /me is refetched and we land on the dashboard. */
export function usePasswordAuth(mode: 'login' | 'signup') {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (v: { email: string; password: string; name?: string }) => (mode === 'login' ? loginWithPassword(v) : signupWithPassword(v)),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ME_KEY });
      navigate('/dashboard', { replace: true });
    },
  });
}
