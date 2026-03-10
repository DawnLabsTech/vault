import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import { POLL_FAST } from '@/lib/constants';
import type { PerformanceSummary } from '@/types/api';

export function usePerformance() {
  return useSWR<PerformanceSummary>('performance', () => apiFetch('/performance'), {
    refreshInterval: POLL_FAST,
  });
}
