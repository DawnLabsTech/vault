import Big from 'big.js';

// Configure Big.js for financial calculations
Big.DP = 18; // decimal places
Big.RM = Big.roundDown;

export { Big };

/** Convert 8h funding rate to annualized percentage */
export function frToAnnualized(fr8h: number): number {
  return fr8h * 3 * 365 * 100;
}

/** Convert annualized percentage to 8h funding rate */
export function annualizedToFr(annualPct: number): number {
  return annualPct / 100 / 3 / 365;
}

/** Calculate Sharpe Ratio from daily returns */
export function calcSharpeRatio(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  return (mean / stdDev) * Math.sqrt(365);
}

/** Calculate max drawdown from NAV series */
export function calcMaxDrawdown(navSeries: number[]): number {
  let peak = navSeries[0] ?? 0;
  let maxDd = 0;
  for (const nav of navSeries) {
    if (nav > peak) peak = nav;
    const dd = (peak - nav) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/** Round to N decimal places */
export function round(value: number, decimals: number): number {
  return Number(new Big(value).round(decimals).toString());
}
