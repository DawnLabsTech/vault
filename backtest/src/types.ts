import type { BotState } from '@bot/types.js';

/** A single 8h tick of funding rate data */
export interface FrTick {
  symbol: string;
  fundingTime: number;   // unix ms
  fundingRate: number;    // raw 8h rate (e.g. 0.0001)
  markPrice: number;
}

/** A single 8h SOL price candle */
export interface SolPriceTick {
  openTime: number;       // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Portfolio state during simulation */
export interface SimPortfolio {
  state: BotState;
  lendingUsdc: number;
  dawnsolAmount: number;      // SOL equivalent staked
  shortSolAmount: number;     // Binance short size in SOL
  binanceMarginUsdc: number;  // USDC margin on Binance
  entryPriceSol: number;      // SOL price at DN entry
  totalNavUsdc: number;

  // Cumulative trackers
  totalFees: number;
  totalFundingReceived: number;
  totalLendingInterest: number;
  totalStakingYield: number;
}

/** Daily snapshot for reporting */
export interface DailySnapshot {
  date: string;           // YYYY-MM-DD
  nav: number;
  dailyReturn: number;
  cumulativeReturn: number;
  state: BotState;
  solPrice: number;
  fundingRate8h: number;  // latest FR of the day
}

/** Backtest configuration */
export interface BacktestConfig {
  startDate: string;      // YYYY-MM-DD
  endDate: string;
  initialCapital: number;
  lendingApy: number;     // fixed annual %
  dawnsolApy: number;     // fixed annual %
  frEntryAnnualized: number;
  frExitAnnualized: number;
  frEmergencyAnnualized: number;
  confirmDays: number;
  dnAllocation: number;   // 0-1
  output: 'table' | 'csv' | 'json';
  fetchOnly: boolean;
}

/** Final backtest results */
export interface BacktestResult {
  config: BacktestConfig;
  dailySnapshots: DailySnapshot[];
  totalReturn: number;
  annualizedReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  daysInBaseOnly: number;
  daysInBaseDn: number;
  totalEntries: number;
  totalExits: number;
  totalFees: number;
  totalFundingReceived: number;
  totalLendingInterest: number;
  totalStakingYield: number;
  // Benchmarks
  solBuyAndHoldReturn: number;
  lendingOnlyReturn: number;
}
