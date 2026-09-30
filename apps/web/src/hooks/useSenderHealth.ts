import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BulkAction, ImportRow, Reconnect, SenderSettings, WarmupUpdate } from '@ri/shared';
import {
  acknowledgeAccount,
  bulkAccounts,
  connectAccount,
  dnsCheck,
  fetchSenderHealth,
  importAccounts,
  reconnectAccount,
  resumeSender,
  testAccount,
  updateSettings,
  updateWarmup,
  type ConnectInput,
} from '@/api/senders';
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

export function useConnectAccount() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (body: ConnectInput) => connectAccount(body), onSuccess: refresh });
}

export function useImportAccounts() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: ({ rows, verify }: { rows: ImportRow[]; verify: boolean }) => importAccounts(rows, verify), onSettled: refresh });
}

export function useBulkAccounts() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (body: BulkAction) => bulkAccounts(body), onSettled: refresh });
}

export function useUpdateSettings() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: SenderSettings }) => updateSettings(id, body), onSettled: refresh });
}

export function useTestAccount() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: ({ id, to }: { id: string; to: string }) => testAccount(id, to), onSettled: refresh });
}

export function useDnsCheck() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: dnsCheck, onSettled: refresh });
}

export function useReconnect() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: Reconnect }) => reconnectAccount(id, body), onSettled: refresh });
}

export function useAcknowledge() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: acknowledgeAccount, onSettled: refresh });
}
