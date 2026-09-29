import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Toaster, toast } from 'sonner';
import { ApiError } from '@/api/client';
import { ME_KEY } from '@/hooks/useAuth';

/** Any 401 anywhere means the session is gone → drop the cached user so guards redirect to /login. */
function onError(err: unknown) {
  if (err instanceof ApiError && err.status === 401) queryClient.setQueryData(ME_KEY, null);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({
    onError: (err) => {
      onError(err);
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster position="top-right" richColors closeButton />
    </QueryClientProvider>
  );
}
