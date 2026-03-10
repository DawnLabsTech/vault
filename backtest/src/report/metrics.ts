import type { BacktestResult } from '../types.js';

/** Format a backtest result into a summary object for display */
export function buildSummary(result: BacktestResult): Record<string, string | number> {
  return {
    'Period': `${result.config.startDate} → ${result.config.endDate}`,
    'Initial Capital': `$${result.config.initialCapital.toLocaleString()}`,
    'Final NAV': `$${(result.config.initialCapital * (1 + result.totalReturn)).toFixed(2)}`,
    'Total Return': `${(result.totalReturn * 100).toFixed(2)}%`,
    'Annualized Return': `${(result.annualizedReturn * 100).toFixed(2)}%`,
    'Sharpe Ratio': result.sharpeRatio.toFixed(3),
    'Max Drawdown': `${(result.maxDrawdown * 100).toFixed(2)}%`,
    '': '',
    'Days in BASE_ONLY': result.daysInBaseOnly,
    'Days in BASE_DN': result.daysInBaseDn,
    'DN Entries': result.totalEntries,
    'DN Exits': result.totalExits,
    ' ': '',
    'Total Fees': `$${result.totalFees.toFixed(2)}`,
    'Funding Received': `$${result.totalFundingReceived.toFixed(2)}`,
    'Lending Interest': `$${result.totalLendingInterest.toFixed(2)}`,
    'Staking Yield': `$${result.totalStakingYield.toFixed(2)}`,
    '  ': '',
    'Benchmark: SOL Buy&Hold': `${(result.solBuyAndHoldReturn * 100).toFixed(2)}%`,
    'Benchmark: Lending Only': `${(result.lendingOnlyReturn * 100).toFixed(2)}%`,
  };
}
