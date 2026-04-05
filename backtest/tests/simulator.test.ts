import { describe, it, expect } from 'vitest';
import { BotState } from '../../bot/src/types.js';
import { runSimulation } from '../src/engine/simulator.js';
import type { FrTick, SolPriceTick, BacktestConfig } from '../src/types.js';
import { buildFrSignals } from '../src/engine/signal-builder.js';

function makeFrTick(time: number, rate: number, price: number): FrTick {
  return { symbol: 'SOLUSDT', fundingTime: time, fundingRate: rate, markPrice: price };
}

function makePriceTick(time: number, price: number): SolPriceTick {
  return { openTime: time, open: price, high: price, low: price, close: price, volume: 1000 };
}

const defaultConfig: BacktestConfig = {
  startDate: '2024-01-01',
  endDate: '2024-01-10',
  initialCapital: 10000,
  multiplyApy: 16,
  multiplyCapacity: Infinity,
  lendingApy: 5,
  dawnsolApy: 7,
  frEntryAnnualized: 10,
  frExitAnnualized: 0,
  frEmergencyAnnualized: -10,
  confirmDays: 3,
  dnAllocation: 0.7,
  output: 'table',
  fetchOnly: false,
};

describe('Signal Builder', () => {
  it('counts consecutive days above threshold', () => {
    const ticks: FrTick[] = [];
    const msPerDay = 24 * 60 * 60 * 1000;
    const msPerTick = 8 * 60 * 60 * 1000;

    // 5 days of high FR (3 ticks per day)
    for (let d = 0; d < 5; d++) {
      for (let t = 0; t < 3; t++) {
        const time = Date.UTC(2024, 0, 1) + d * msPerDay + t * msPerTick;
        // 15% annualized = 15 / 100 / 3 / 365 ≈ 0.0001370
        ticks.push(makeFrTick(time, 0.000137, 100));
      }
    }

    const signals = buildFrSignals(ticks, 10, 0);
    expect(signals.daysAboveEntry).toBe(5);
    expect(signals.daysBelowExit).toBe(0);
  });

  it('breaks consecutive count on mixed days', () => {
    const ticks: FrTick[] = [];
    const msPerDay = 24 * 60 * 60 * 1000;
    const msPerTick = 8 * 60 * 60 * 1000;

    // Day 0: high FR
    for (let t = 0; t < 3; t++) {
      ticks.push(makeFrTick(Date.UTC(2024, 0, 1) + t * msPerTick, 0.000137, 100));
    }
    // Day 1: low FR (breaks streak)
    for (let t = 0; t < 3; t++) {
      ticks.push(makeFrTick(Date.UTC(2024, 0, 2) + t * msPerTick, -0.0001, 100));
    }
    // Day 2: high FR
    for (let t = 0; t < 3; t++) {
      ticks.push(makeFrTick(Date.UTC(2024, 0, 3) + t * msPerTick, 0.000137, 100));
    }

    const signals = buildFrSignals(ticks, 10, 0);
    // Only the last day counts (streak broken by day 1)
    expect(signals.daysAboveEntry).toBe(1);
  });
});

describe('Simulator', () => {
  it('stays BASE_ONLY when FR is below entry threshold', () => {
    const msPerTick = 8 * 60 * 60 * 1000;
    const baseTime = Date.UTC(2024, 0, 1);
    const ticks = 30; // 10 days

    const frTicks: FrTick[] = [];
    const priceTicks: SolPriceTick[] = [];

    for (let i = 0; i < ticks; i++) {
      const time = baseTime + i * msPerTick;
      // Low FR: 5% annualized (below 10% entry)
      frTicks.push(makeFrTick(time, 0.0000456, 100));
      priceTicks.push(makePriceTick(time, 100));
    }

    const result = runSimulation(frTicks, priceTicks, defaultConfig);
    expect(result.totalEntries).toBe(0);
    expect(result.totalExits).toBe(0);
    expect(result.daysInBaseDn).toBe(0);
    // With unlimited Multiply capacity, all capital goes to Multiply
    expect(result.totalMultiplyYield).toBeGreaterThan(0);
    // Lending interest should be 0 (no overflow)
    expect(result.totalLendingInterest).toBe(0);
  });

  it('earns both Multiply and Lending yield with capacity limit', () => {
    const msPerTick = 8 * 60 * 60 * 1000;
    const baseTime = Date.UTC(2024, 0, 1);
    const ticks = 30;

    const frTicks: FrTick[] = [];
    const priceTicks: SolPriceTick[] = [];

    for (let i = 0; i < ticks; i++) {
      const time = baseTime + i * msPerTick;
      frTicks.push(makeFrTick(time, 0.0000456, 100));
      priceTicks.push(makePriceTick(time, 100));
    }

    const config = { ...defaultConfig, multiplyCapacity: 5000 };
    const result = runSimulation(frTicks, priceTicks, config);
    expect(result.totalMultiplyYield).toBeGreaterThan(0);
    expect(result.totalLendingInterest).toBeGreaterThan(0);
  });

  it('enters DN when FR exceeds threshold for confirm days', () => {
    const msPerTick = 8 * 60 * 60 * 1000;
    const baseTime = Date.UTC(2024, 0, 1);

    const frTicks: FrTick[] = [];
    const priceTicks: SolPriceTick[] = [];

    // 10 days of high FR (should trigger entry after 3 confirm days)
    for (let i = 0; i < 30; i++) {
      const time = baseTime + i * msPerTick;
      // 20% annualized FR
      frTicks.push(makeFrTick(time, 0.000183, 100));
      priceTicks.push(makePriceTick(time, 100));
    }

    const result = runSimulation(frTicks, priceTicks, defaultConfig);
    expect(result.totalEntries).toBeGreaterThanOrEqual(1);
    expect(result.daysInBaseDn).toBeGreaterThan(0);
  });

  it('calculates benchmarks correctly', () => {
    const msPerTick = 8 * 60 * 60 * 1000;
    const baseTime = Date.UTC(2024, 0, 1);

    const frTicks: FrTick[] = [];
    const priceTicks: SolPriceTick[] = [];

    // SOL goes from 100 to 150
    for (let i = 0; i < 30; i++) {
      const time = baseTime + i * msPerTick;
      const price = 100 + (50 * i / 29);
      frTicks.push(makeFrTick(time, 0.0000456, price));
      priceTicks.push(makePriceTick(time, price));
    }

    const result = runSimulation(frTicks, priceTicks, defaultConfig);
    // SOL buy and hold: (150-100)/100 = 50%
    expect(result.solBuyAndHoldReturn).toBeCloseTo(0.5, 1);
    // Benchmarks should be positive
    expect(result.multiplyOnlyReturn).toBeGreaterThan(0);
    expect(result.lendingOnlyReturn).toBeGreaterThan(0);
    expect(result.multiplyOnlyReturn).toBeGreaterThan(result.lendingOnlyReturn);
  });
});
