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

async function fetchBinanceFrHistory(months: number): Promise<FundingRateData[]> {
  const res = await fetch(`/api/fr-history?months=${months}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to fetch FR history from Binance');
  const data = await res.json();
  return (data as any[]).map((d) => ({
    symbol: d.symbol,
    fundingRate: parseFloat(d.fundingRate),
    fundingTime: d.fundingTime,
    markPrice: d.markPrice ? parseFloat(d.markPrice) : undefined,
  }));
}

export function useFrHistory(months = 3) {
  return useSWR<FundingRateData[]>(
    ['fr-history', months],
    () => fetchBinanceFrHistory(months),
    { refreshInterval: 5 * 60 * 1000 } // 5min
  );
}
