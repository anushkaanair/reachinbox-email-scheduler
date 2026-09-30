import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DraftPayload } from '@ri/shared';
import { createDraft, deleteDraft, getDraft, listDrafts, updateDraft } from '@/api/drafts';

const KEY = ['drafts'] as const;

export const useDrafts = () => useQuery({ queryKey: KEY, queryFn: listDrafts });

/** Opens one draft into the composer. Not cached for long: the copy on the server is the source of truth. */
export const useDraft = (id: string | null) => useQuery({ queryKey: [...KEY, id], queryFn: () => getDraft(id!), enabled: Boolean(id), staleTime: 0, gcTime: 0 });

export function useSaveDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string | null; payload: DraftPayload }) => (id ? updateDraft(id, payload) : createDraft(payload)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: deleteDraft, onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }) });
}
