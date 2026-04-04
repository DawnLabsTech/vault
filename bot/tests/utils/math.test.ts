import { describe, expect, it } from 'vitest';
import { frToAnnualized, annualizedToFr, calcSharpeRatio, calcMaxDrawdown, round } from '../../src/utils/math.js';

describe('frToAnnualized', () => {
  it('converts 8h funding rate to annualized percentage', () => {
    // 0.01% per 8h = 0.0001 * 3 * 365 * 100 = 10.95%
    expect(frToAnnualized(0.0001)).toBeCloseTo(10.95, 2);
  });

  it('handles negative funding rates', () => {
    expect(frToAnnualized(-0.0001)).toBeCloseTo(-10.95, 2);
  });

  it('handles zero', () => {
    expect(frToAnnualized(0)).toBe(0);
  });

  it('accepts custom periods per day', () => {
    // 1h funding: 24 periods per day
    expect(frToAnnualized(0.0001, 24)).toBeCloseTo(87.6, 1);
  });
});

describe('annualizedToFr', () => {
  it('converts annualized percentage back to per-period rate', () => {
    const fr = annualizedToFr(10.95);
    expect(fr).toBeCloseTo(0.0001, 6);
  });

  it('roundtrips with frToAnnualized', () => {
    const original = 0.00025;
    const annualized = frToAnnualized(original);
    const recovered = annualizedToFr(annualized);
    expect(recovered).toBeCloseTo(original, 10);
  });

  it('handles zero', () => {
    expect(annualizedToFr(0)).toBe(0);
  });
});

describe('calcSharpeRatio', () => {
  it('returns 0 for fewer than 2 data points', () => {
    expect(calcSharpeRatio([])).toBe(0);
    expect(calcSharpeRatio([0.01])).toBe(0);
  });

  it('returns 0 when all returns are identical (zero std dev)', () => {
    expect(calcSharpeRatio([0.01, 0.01, 0.01])).toBe(0);
  });

  it('calculates annualized Sharpe from daily returns', () => {
    // Positive mean, moderate variance
    const dailyReturns = [0.01, 0.02, -0.005, 0.015, 0.008];
    const sharpe = calcSharpeRatio(dailyReturns);
    expect(sharpe).toBeGreaterThan(0);
  });

  it('returns negative Sharpe for negative mean returns', () => {
    const dailyReturns = [-0.01, -0.02, -0.005, -0.015, -0.008];
    const sharpe = calcSharpeRatio(dailyReturns);
    expect(sharpe).toBeLessThan(0);
  });

  it('higher consistent returns yield higher Sharpe', () => {
    // Different mean/stddev ratios to get different Sharpe
    const low = calcSharpeRatio([0.001, -0.001, 0.002, -0.002]);
    const high = calcSharpeRatio([0.01, 0.005, 0.012, 0.008]);
    expect(high).toBeGreaterThan(low);
  });
});

describe('calcMaxDrawdown', () => {
  it('returns 0 for monotonically increasing NAV', () => {
    expect(calcMaxDrawdown([100, 101, 102, 103])).toBe(0);
  });

  it('returns 0 for empty series', () => {
    expect(calcMaxDrawdown([])).toBe(0);
  });

  it('calculates drawdown correctly for a single dip', () => {
    // Peak 100, dip to 90 = 10% drawdown
    const dd = calcMaxDrawdown([100, 95, 90, 92, 95]);
    expect(dd).toBeCloseTo(0.1, 6);
  });

  it('tracks max drawdown across multiple dips', () => {
    // First dip: 100 -> 92 = 8%, second dip: 105 -> 84 = 20%
    const dd = calcMaxDrawdown([100, 92, 95, 105, 84, 90]);
    expect(dd).toBeCloseTo(0.2, 6);
  });

  it('handles single element', () => {
    expect(calcMaxDrawdown([100])).toBe(0);
  });
});

describe('round', () => {
  it('rounds to specified decimal places', () => {
    expect(round(1.23456, 2)).toBe(1.23);
    expect(round(1.23456, 4)).toBe(1.2345);
  });

  it('handles zero decimals', () => {
    expect(round(1.7, 0)).toBe(1);
  });

  it('handles negative numbers (rounds toward zero per Big.js roundDown)', () => {
    expect(round(-1.23456, 2)).toBe(-1.23);
  });
});
