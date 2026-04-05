import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import { POLL_SLOW } from '@/lib/constants';
import type { AdvisorResponse } from '@/types/api';

export function useAdvisor(limit = 20) {
  return useSWR<AdvisorResponse>(
    ['advisor', limit],
    () => apiFetch('/advisor', { limit: String(limit) }),
    { refreshInterval: POLL_SLOW }
  );
}
