import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import { POLL_FAST } from '@/lib/constants';
import type { LedgerEvent } from '@/types/api';

export function useEvents(limit = 50) {
  return useSWR<LedgerEvent[]>(
    ['events', limit],
    () => apiFetch('/events', { limit: String(limit) }),
    { refreshInterval: POLL_FAST }
  );
}
