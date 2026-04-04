import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import { POLL_SLOW } from '@/lib/constants';
import type { MultiplyResponse } from '@/types/api';

export function useMultiply() {
  return useSWR<MultiplyResponse>('multiply', () => apiFetch('/multiply'), {
    refreshInterval: POLL_SLOW,
  });
}
