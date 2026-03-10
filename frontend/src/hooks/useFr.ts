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

const BINANCE_FAPI = 'https://fapi.binance.com';
const DRIFT_API = 'https://data.api.drift.trade';

async function fetchBinanceFrHistory(months: number): Promise<FundingRateData[]> {
  const startTime = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  const url = `${BINANCE_FAPI}/fapi/v1/fundingRate?symbol=SOLUSDC&startTime=${startTime}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch FR history from Binance');
  const data = await res.json();
  return (data as any[]).map((d) => ({
    symbol: d.symbol,
    fundingRate: parseFloat(d.fundingRate),
    fundingTime: d.fundingTime,
    markPrice: d.markPrice ? parseFloat(d.markPrice) : undefined,
  }));
}

async function fetchDriftFrHistory(months: number): Promise<FundingRateData[]> {
  const startTime = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  const res = await fetch(`${DRIFT_API}/fundingRates?marketIndex=0`);
  if (!res.ok) throw new Error('Failed to fetch FR history from Drift');
  const json = await res.json();
  // API returns { fundingRates: [...] }
  const records: any[] = json.fundingRates ?? json;
  return records
    .filter((d) => {
      const ts = parseInt(d.ts) * 1000;
      return ts >= startTime;
    })
    .map((d) => ({
      symbol: 'SOL-PERP',
      fundingRate: parseInt(d.fundingRate) / 1e9,
      fundingTime: parseInt(d.ts) * 1000,
    }));
}

export function useFrHistory(months = 3, exchange: string = 'binance') {
  return useSWR<FundingRateData[]>(
    ['fr-history', months, exchange],
    () => exchange === 'drift'
      ? fetchDriftFrHistory(months)
      : fetchBinanceFrHistory(months),
    { refreshInterval: 5 * 60 * 1000 } // 5min
  );
}

/** Returns the perp exchange currently configured on the bot. */
export function useActivePerpExchange() {
  return useSWR<{ perpExchange: string }>(
    'config',
    () => apiFetch<{ perpExchange: string }>('/config').catch(() => ({ perpExchange: 'binance' })),
    { refreshInterval: 0, revalidateOnFocus: false, fallbackData: { perpExchange: 'binance' } }
  );
}

