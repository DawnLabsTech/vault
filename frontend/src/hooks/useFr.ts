import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import { POLL_SLOW } from '@/lib/constants';
import type { FundingRateData } from '@/types/api';

export function useFr(limit = 504) {
  return useSWR<FundingRateData[]>(
    ['fr', limit],
    () => apiFetch('/fr', { limit: String(limit) }),
    { refreshInterval: POLL_SLOW }
  );
}

export function useFrHistory(months = 3) {
  return useSWR<FundingRateData[]>(
    ['fr-history', months],
    () => apiFetch('/fr-history', { months: String(months) }),
    { refreshInterval: 5 * 60 * 1000 } // 5min
  );
}
