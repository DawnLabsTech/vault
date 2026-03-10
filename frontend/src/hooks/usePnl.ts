import useSWR from 'swr';
import { apiFetch } from '@/lib/api';
import { POLL_SLOW } from '@/lib/constants';
import type { DailyPnL } from '@/types/api';

export function usePnl(from?: string) {
  const defaultFrom = new Date(Date.now() - 90 * 86_400_000).toISOString().split('T')[0]!;
  const params: Record<string, string> = { from: from || defaultFrom };

  return useSWR<DailyPnL[]>(
    ['pnl', params.from],
    () => apiFetch('/pnl', params),
    { refreshInterval: POLL_SLOW }
  );
}
