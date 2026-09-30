import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateLeadList, LeadStatus } from '@ri/shared';
import { createLeadList, deleteLeadList, fetchLeadPage, fetchListRecipients, getLeadList, listLeadLists, removeLeadsByStatus, verifyLeadList } from '@/api/leadLists';

const KEY = ['lead-lists'] as const;

export const useLeadLists = () => useQuery({ queryKey: KEY, queryFn: listLeadLists });
export const useLeadList = (id: string) => useQuery({ queryKey: [...KEY, id], queryFn: () => getLeadList(id) });

export function useLeadPage(id: string, status?: string) {
  const q = useInfiniteQuery({
    queryKey: [...KEY, id, 'leads', status ?? 'all'],
    queryFn: ({ pageParam }) => fetchLeadPage(id, status, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  return { ...q, rows: q.data?.pages.flatMap((p) => p.items) ?? [], total: q.data?.pages[0]?.total ?? 0 };
}

function useRefresh() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: KEY });
}

export function useCreateLeadList() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (b: CreateLeadList) => createLeadList(b), onSuccess: refresh });
}
export function useDeleteLeadList() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: deleteLeadList, onSuccess: refresh });
}
export function useVerifyLeadList() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: verifyLeadList, onSettled: refresh });
}
export function useRemoveLeads() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: ({ id, status }: { id: string; status: LeadStatus }) => removeLeadsByStatus(id, status), onSuccess: refresh });
}
export const loadListRecipients = fetchListRecipients;
