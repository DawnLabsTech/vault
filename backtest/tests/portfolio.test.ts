import { describe, it, expect } from 'vitest';
import { BotState } from '../../bot/src/types.js';
import {
  createPortfolio,
  allocateCapital,
  accrueMultiplyYield,
  accrueLendingInterest,
  accrueFunding,
  accrueDawnsolYield,
  enterDn,
  exitDn,
  updateNav,
} from '../src/engine/portfolio.js';

describe('Portfolio', () => {
  it('creates initial portfolio in BASE_ONLY', () => {
    const p = createPortfolio(10000);
    expect(p.state).toBe(BotState.BASE_ONLY);
    expect(p.multiplyUsdc).toBe(0);
    expect(p.lendingUsdc).toBe(10000);
    expect(p.totalNavUsdc).toBe(10000);
    expect(p.dawnsolAmount).toBe(0);
    expect(p.shortSolAmount).toBe(0);
    expect(p.totalMultiplyYield).toBe(0);
  });

  it('allocates capital to Multiply first (unlimited capacity)', () => {
    const p = createPortfolio(10000);
    allocateCapital(p, Infinity);
    expect(p.multiplyUsdc).toBe(10000);
    expect(p.lendingUsdc).toBe(0);
  });

  it('allocates capital with capacity limit', () => {
    const p = createPortfolio(10000);
    allocateCapital(p, 6000);
    expect(p.multiplyUsdc).toBe(6000);
    expect(p.lendingUsdc).toBe(4000);
  });

  it('accrues Multiply yield correctly', () => {
    const p = createPortfolio(10000);
    allocateCapital(p, Infinity);
    // 16% APY for 8 hours: 10000 * 0.16 * (8/8760) ≈ 1.4612
    accrueMultiplyYield(p, 16);
    expect(p.multiplyUsdc).toBeGreaterThan(10000);
    expect(p.multiplyUsdc).toBeCloseTo(10001.4612, 2);
    expect(p.totalMultiplyYield).toBeCloseTo(1.4612, 2);
  });

  it('accrues lending interest correctly', () => {
    const p = createPortfolio(10000);
    // Keep all in lending (no Multiply)
    allocateCapital(p, 0);
    // 5% APY for 8 hours: 10000 * 0.05 * (8/8760) ≈ 0.4566
    accrueLendingInterest(p, 5);
    expect(p.lendingUsdc).toBeGreaterThan(10000);
    expect(p.lendingUsdc).toBeCloseTo(10000.4566, 2);
    expect(p.totalLendingInterest).toBeCloseTo(0.4566, 2);
  });

  it('accrues funding payment for shorts', () => {
    const p = createPortfolio(10000);
    p.shortSolAmount = 10;
    p.binanceMarginUsdc = 1000;
    // Positive FR = income for shorts
    accrueFunding(p, 100, 0.0001);
    // 10 SOL * 100 USD * 0.0001 = 0.1 USDC
    expect(p.binanceMarginUsdc).toBeCloseTo(1000.1, 4);
    expect(p.totalFundingReceived).toBeCloseTo(0.1, 4);
  });

  it('accrues dawnsol staking yield', () => {
    const p = createPortfolio(10000);
    p.dawnsolAmount = 10;
    // 7% APY for 8 hours
    accrueDawnsolYield(p, 100, 7);
    const expectedYieldSol = 10 * 0.07 * (8 / 8760);
    expect(p.dawnsolAmount).toBeCloseTo(10 + expectedYieldSol, 6);
  });

  it('enters DN position splitting capital correctly', () => {
    const p = createPortfolio(10000);
    allocateCapital(p, Infinity); // all in Multiply
    enterDn(p, 100, 0.7);
    expect(p.state).toBe(BotState.BASE_DN);
    // 70% of 10000 = 7000 allocated to DN
    // Lending was 0, so all pulled from Multiply
    expect(p.multiplyUsdc).toBeCloseTo(3000, 0);
    expect(p.lendingUsdc).toBe(0);
    expect(p.dawnsolAmount).toBeGreaterThan(0);
    expect(p.shortSolAmount).toBeGreaterThan(0);
    expect(p.dawnsolAmount).toBeCloseTo(p.shortSolAmount, 6);
    expect(p.entryPriceSol).toBe(100);
    expect(p.totalFees).toBeGreaterThan(0);
  });

  it('enters DN pulling from lending first, then Multiply', () => {
    const p = createPortfolio(10000);
    allocateCapital(p, 6000); // 6000 Multiply, 4000 Lending
    enterDn(p, 100, 0.7);
    // DN needs 7000: takes 4000 from lending, 3000 from Multiply
    expect(p.lendingUsdc).toBe(0);
    expect(p.multiplyUsdc).toBeCloseTo(3000, 0);
  });

  it('exits DN position correctly', () => {
    const p = createPortfolio(10000);
    allocateCapital(p, Infinity);
    enterDn(p, 100, 0.7);
    const navAfterEntry = p.multiplyUsdc + p.lendingUsdc + p.dawnsolAmount * 100 + p.binanceMarginUsdc;

    // Exit at same price (should only lose fees)
    exitDn(p, 100);
    expect(p.state).toBe(BotState.BASE_ONLY);
    expect(p.dawnsolAmount).toBe(0);
    expect(p.shortSolAmount).toBe(0);
    expect(p.binanceMarginUsdc).toBe(0);
    // Recovered capital goes to lending; allocateCapital in simulator redistributes
    expect(p.multiplyUsdc + p.lendingUsdc).toBeLessThan(navAfterEntry);
  });

  it('updates NAV with mark-to-market for short', () => {
    const p = createPortfolio(10000);
    allocateCapital(p, Infinity);
    enterDn(p, 100, 0.7);
    updateNav(p, 100); // recalculate NAV at entry price
    const navAfterEntry = p.totalNavUsdc;

    // SOL drops to 90: short profits offset dawnSOL loss (delta-neutral)
    updateNav(p, 90);
    expect(p.totalNavUsdc).toBeCloseTo(navAfterEntry, 0);

    // SOL rises to 110: short loses offset by dawnSOL gain
    updateNav(p, 110);
    expect(p.totalNavUsdc).toBeCloseTo(navAfterEntry, 0);
  });
});
