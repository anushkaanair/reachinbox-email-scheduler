import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchMe, logout } from '@/api/auth';

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
