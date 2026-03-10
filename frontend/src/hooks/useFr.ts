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

interface BinanceFrRecord {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
  markPrice: string;
}

export function useFrHistory(months = 3) {
  return useSWR<FundingRateData[]>(
    ['fr-history', months],
    async () => {
      const res = await fetch(`/api/fr-history?months=${months}`);
      if (!res.ok) throw new Error('Failed to fetch FR history');
      const data: BinanceFrRecord[] = await res.json();
      return data.map((d) => ({
        symbol: d.symbol,
        fundingRate: parseFloat(d.fundingRate),
        fundingTime: d.fundingTime,
        markPrice: d.markPrice ? parseFloat(d.markPrice) : undefined,
      }));
    },
    { refreshInterval: 5 * 60 * 1000 } // 5min
  );
}
