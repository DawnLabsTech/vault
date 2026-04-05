import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEvent, PortfolioSnapshot } from '../../src/types.js';

let snapshots: PortfolioSnapshot[] = [];
let events: LedgerEvent[] = [];

vi.mock('../../src/measurement/snapshots.js', () => ({
  getSnapshots: (opts: { from?: string; to?: string }) => snapshots.filter((snapshot) => {
    if (opts.from && snapshot.timestamp < opts.from) return false;
    if (opts.to && snapshot.timestamp > opts.to) return false;
    return true;
  }),
}));

vi.mock('../../src/measurement/events.js', () => ({
  getEvents: (opts: { from?: string; to?: string }) => events.filter((event) => {
    if (opts.from && event.timestamp < opts.from) return false;
    if (opts.to && event.timestamp > opts.to) return false;
    return true;
  }),
}));

vi.mock('../../src/measurement/db.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (params?: Record<string, string>) => {
        if (sql.includes('SELECT DISTINCT DATE(timestamp) as date')) {
          const from = params?.from ?? '0000-01-01';
          const to = params?.to ?? '9999-12-31';
          const dates = Array.from(
            new Set(
              snapshots
                .map((snapshot) => snapshot.timestamp.slice(0, 10))
                .filter((date) => date >= from && date <= to),
            ),
          ).sort();
          return dates.map((date) => ({ date }));
        }
        return [];
      },
      get: () => undefined,
      run: () => undefined,
    }),
  }),
}));

describe('pnl external flow adjustments', () => {
  beforeEach(() => {
    snapshots = [];
    events = [];
    vi.resetModules();
  });

  it('detects external wallet top-ups even when part of the cash is redeployed', async () => {
    const { estimateExternalUsdcFlow } = await import('../../src/measurement/pnl.js');

    const daySnapshots: PortfolioSnapshot[] = [
      {
        timestamp: '2026-04-05T00:00:00.000Z',
        totalNavUsdc: 100,
        lendingBalance: 40,
        lendingBreakdown: { kamino: 40 },
        multiplyBalance: 50,
        multiplyBreakdown: { 'ONyc/USDC': 50 },
        dawnsolBalance: 0,
        dawnsolUsdcValue: 0,
        bufferUsdcBalance: 10,
        binanceUsdcBalance: 0,
        binancePerpUnrealizedPnl: 0,
        binancePerpSize: 0,
        state: 'BASE_ONLY',
        solPrice: 100,
        dawnsolPrice: 100,
      },
      {
        timestamp: '2026-04-05T23:59:59.000Z',
        totalNavUsdc: 150,
        lendingBalance: 40,
        lendingBreakdown: { kamino: 40 },
        multiplyBalance: 97.5,
        multiplyBreakdown: { 'ONyc/USDC': 97.5 },
        dawnsolBalance: 0,
        dawnsolUsdcValue: 0,
        bufferUsdcBalance: 12.5,
        binanceUsdcBalance: 0,
        binancePerpUnrealizedPnl: 0,
        binancePerpSize: 0,
        state: 'BASE_ONLY',
        solPrice: 100,
        dawnsolPrice: 100,
      },
    ];

    const dayEvents: LedgerEvent[] = [
      {
        timestamp: '2026-04-05T12:00:00.000Z',
        eventType: 'deposit' as const,
        amount: 47.5,
        asset: 'USDC',
        metadata: { action: 'capital_rebalance_multiply_deposit' },
      },
    ];

    expect(estimateExternalUsdcFlow(daySnapshots, dayEvents)).toBe(50);
  });

  it('excludes external deposits from total return', async () => {
    snapshots = [
      {
        timestamp: '2026-04-04T00:00:00.000Z',
        totalNavUsdc: 100,
        lendingBalance: 0,
        lendingBreakdown: {},
        multiplyBalance: 90,
        multiplyBreakdown: { 'ONyc/USDC': 90 },
        dawnsolBalance: 0,
        dawnsolUsdcValue: 0,
        bufferUsdcBalance: 10,
        binanceUsdcBalance: 0,
        binancePerpUnrealizedPnl: 0,
        binancePerpSize: 0,
        state: 'BASE_ONLY',
        solPrice: 100,
        dawnsolPrice: 100,
      },
      {
        timestamp: '2026-04-04T23:59:59.000Z',
        totalNavUsdc: 101,
        lendingBalance: 0,
        lendingBreakdown: {},
        multiplyBalance: 91,
        multiplyBreakdown: { 'ONyc/USDC': 91 },
        dawnsolBalance: 0,
        dawnsolUsdcValue: 0,
        bufferUsdcBalance: 10,
        binanceUsdcBalance: 0,
        binancePerpUnrealizedPnl: 0,
        binancePerpSize: 0,
        state: 'BASE_ONLY',
        solPrice: 100,
        dawnsolPrice: 100,
      },
      {
        timestamp: '2026-04-05T00:00:00.000Z',
        totalNavUsdc: 101,
        lendingBalance: 0,
        lendingBreakdown: {},
        multiplyBalance: 91,
        multiplyBreakdown: { 'ONyc/USDC': 91 },
        dawnsolBalance: 0,
        dawnsolUsdcValue: 0,
        bufferUsdcBalance: 10,
        binanceUsdcBalance: 0,
        binancePerpUnrealizedPnl: 0,
        binancePerpSize: 0,
        state: 'BASE_ONLY',
        solPrice: 100,
        dawnsolPrice: 100,
      },
      {
        timestamp: '2026-04-05T23:59:59.000Z',
        totalNavUsdc: 151,
        lendingBalance: 0,
        lendingBreakdown: {},
        multiplyBalance: 91,
        multiplyBreakdown: { 'ONyc/USDC': 91 },
        dawnsolBalance: 0,
        dawnsolUsdcValue: 0,
        bufferUsdcBalance: 60,
        binanceUsdcBalance: 0,
        binancePerpUnrealizedPnl: 0,
        binancePerpSize: 0,
        state: 'BASE_ONLY',
        solPrice: 100,
        dawnsolPrice: 100,
      },
    ];

    const { getPerformanceSummary } = await import('../../src/measurement/pnl.js');
    const summary = getPerformanceSummary();

    // MWR: invested 100 initial + 50 deposit = 150, final NAV = 151 → (151-150)/150
    expect(summary.totalReturn).toBeCloseTo(1 / 150, 4);
  });

  it('ignores internal rebalance events that happen after the last snapshot of the day', async () => {
    snapshots = [
      {
        timestamp: '2026-04-04T17:04:02.163Z',
        totalNavUsdc: 100.084127683101,
        lendingBalance: 0.000196,
        lendingBreakdown: { kamino: 0.000196 },
        multiplyBalance: 50.0839316831008,
        multiplyBreakdown: { 'ONyc/USDC': 50.0839316831008 },
        dawnsolBalance: 0,
        dawnsolUsdcValue: 0,
        bufferUsdcBalance: 50,
        binanceUsdcBalance: 0,
        binancePerpUnrealizedPnl: 0,
        binancePerpSize: 0,
        state: 'BASE_ONLY',
        solPrice: 100,
        dawnsolPrice: 100,
      },
      {
        timestamp: '2026-04-04T17:04:10.089Z',
        totalNavUsdc: 100.083930380723,
        lendingBalance: 0,
        lendingBreakdown: {},
        multiplyBalance: 50.0839303807228,
        multiplyBreakdown: { 'ONyc/USDC': 50.0839303807228 },
        dawnsolBalance: 0,
        dawnsolUsdcValue: 0,
        bufferUsdcBalance: 50,
        binanceUsdcBalance: 0,
        binancePerpUnrealizedPnl: 0,
        binancePerpSize: 0,
        state: 'BASE_ONLY',
        solPrice: 100,
        dawnsolPrice: 100,
      },
    ];

    events = [
      {
        timestamp: '2026-04-04T17:04:14.154Z',
        eventType: 'deposit' as const,
        amount: 17.998396,
        asset: 'USDC',
        fee: 0.000005,
        sourceProtocol: 'kamino',
        metadata: { action: 'rebalance_deposit', previousBalance: 0 },
      },
      {
        timestamp: '2026-04-04T17:04:17.136Z',
        eventType: 'deposit' as const,
        amount: 26.997398,
        asset: 'USDC',
        fee: 0.000005,
        sourceProtocol: 'jupiter',
        metadata: { action: 'rebalance_deposit', previousBalance: 0.000196 },
      },
    ];

    const { getPerformanceSummary } = await import('../../src/measurement/pnl.js');
    const summary = getPerformanceSummary();

    expect(summary.totalReturn).toBe(-0.000001);
  });
});
