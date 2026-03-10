import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import { POLL_SLOW } from '@/lib/constants';
import type { ApysResponse } from '@/types/api';

export function useApys() {
  return useSWR<ApysResponse>('apys', () => apiFetch('/apys'), {
    refreshInterval: POLL_SLOW,
  });
}
