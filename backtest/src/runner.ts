import { DataStore } from './data/data-store.js';
import { fetchFundingRates } from './data/fetch-funding-rates.js';
import { fetchSolPrices } from './data/fetch-sol-prices.js';
import { runSimulation } from './engine/simulator.js';
import type { BacktestConfig, BacktestResult } from './types.js';

const DEFAULT_CONFIG: BacktestConfig = {
  startDate: '2024-01-01',
  endDate: '2026-04-01',
  initialCapital: 10000,
  multiplyApy: 13,
  multiplyCapacity: Infinity,
  lendingApy: 5,
  dawnsolApy: 6.8,
  frEntryAnnualized: 10,
  frExitAnnualized: 0,
  frEmergencyAnnualized: -10,
  confirmDays: 3,
  dnAllocation: 0.7,
  output: 'json',
  fetchOnly: false,
};

/**
 * Run a backtest programmatically with the given config overrides.
 * Returns the BacktestResult directly.
 */
export async function runBacktest(config: Partial<BacktestConfig>): Promise<BacktestResult> {
  const fullConfig: BacktestConfig = { ...DEFAULT_CONFIG, ...config, output: 'json', fetchOnly: false };
  const store = new DataStore();

  try {
    await fetchFundingRates(store, 'SOLUSDT', fullConfig.startDate, fullConfig.endDate);
    await fetchSolPrices(store, 'SOLUSDT', fullConfig.startDate, fullConfig.endDate);

    const startMs = new Date(fullConfig.startDate).getTime();
    const endMs = new Date(fullConfig.endDate).getTime();

    const frTicks = store.getFundingRates('SOLUSDT', startMs, endMs);
    const priceTicks = store.getSolPrices(startMs, endMs);

    if (frTicks.length === 0 || priceTicks.length === 0) {
      throw new Error(`No data available for ${fullConfig.startDate} to ${fullConfig.endDate}`);
    }

    return runSimulation(frTicks, priceTicks, fullConfig);
  } finally {
    store.close();
  }
}
