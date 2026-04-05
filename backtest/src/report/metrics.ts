import type { BacktestResult } from '../types.js';

/** Convert a total return over N days to annualized return */
function annualizeBenchmark(totalReturn: number, days: number): number {
  if (days <= 0) return 0;
  return Math.pow(1 + totalReturn, 365 / days) - 1;
}

/** Format a backtest result into a summary object for display */
export function buildSummary(result: BacktestResult): Record<string, string | number> {
  return {
    'Period': `${result.config.startDate} → ${result.config.endDate}`,
    'Initial Capital': `$${result.config.initialCapital.toLocaleString()}`,
    'Final NAV': `$${(result.config.initialCapital * (1 + result.totalReturn)).toFixed(2)}`,
    'APY': `${(result.annualizedReturn * 100).toFixed(2)}%`,
    'Sharpe Ratio': result.sharpeRatio.toFixed(3),
    'Max Drawdown': `${(result.maxDrawdown * 100).toFixed(2)}%`,
    '': '',
    'Days in BASE_ONLY': result.daysInBaseOnly,
    'Days in BASE_DN': result.daysInBaseDn,
    'DN Entries': result.totalEntries,
    'DN Exits': result.totalExits,
    ' ': '',
    'Benchmark: SOL Buy&Hold': `${(annualizeBenchmark(result.solBuyAndHoldReturn, result.dailySnapshots.length) * 100).toFixed(2)}%`,
    'Benchmark: Multiply Only': `${(result.config.multiplyApy).toFixed(2)}%`,
    'Benchmark: Lending Only': `${(result.config.lendingApy).toFixed(2)}%`,
  };
}
