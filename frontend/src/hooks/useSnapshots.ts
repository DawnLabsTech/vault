import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import { POLL_SLOW } from '@/lib/constants';
import type { PortfolioSnapshot } from '@/types/api';

export function useSnapshots(limit = 288) {
  return useSWR<PortfolioSnapshot[]>(
    ['snapshots', limit],
    () => apiFetch('/snapshots', { limit: String(limit) }),
    { refreshInterval: POLL_SLOW }
  );
}
