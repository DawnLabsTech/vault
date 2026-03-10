import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import { POLL_FAST } from '@/lib/constants';
import type { StatusResponse } from '@/types/api';

export function useStatus() {
  return useSWR<StatusResponse>('status', () => apiFetch('/status'), {
    refreshInterval: POLL_FAST,
  });
}
