import { describe, it, expect } from 'vitest';
import { BaseAllocator } from '../../src/strategies/base-allocator.js';
import type { VaultConfig, LendingProtocol } from '../../src/types.js';

const config: VaultConfig = {
  general: {
    dryRun: true,
    logLevel: 'silent',
    tickIntervalMs: 30_000,
    snapshotIntervalMs: 300_000,
    lendingRebalanceIntervalMs: 21_600_000,
    dailyPnlTimeUtc: '00:00',
  },
  perp: { exchange: 'binance' as const, symbol: 'SOLUSDC', leverage: 1, swapSlippageBps: 50 },
  binance: { symbol: 'SOLUSDC', leverage: 1, testnet: true, swapSlippageBps: 50 },
  solana: { network: 'devnet' },
  thresholds: {
    frEntryAnnualized: 10,
    frEntryConfirmationDays: 3,
    frExitAnnualized: 0,
    frExitConfirmationDays: 3,
    frEmergencyAnnualized: -10,
    dnAllocationMax: 0.7,
    lendingRebalanceMinDiffBps: 50,
  },
  risk: {
    dailyLossLimitPct: 2,
    maxPositionCapUsd: 10_000,
    maxTransferSizeUsd: 5_000,
    positionDivergenceThresholdPct: 3,
  },
  lending: { protocols: ['kamino', 'drift', 'jupiter'], bufferPct: 5 },
};

function makeMockProtocol(name: string, apy: number, balance: number): LendingProtocol {
  return {
    name,
    getApy: async () => apy,
    getBalance: async () => balance,
    deposit: async (_amount: number) => 'mock-tx-deposit',
    withdraw: async (_amount: number) => 'mock-tx-withdraw',
  };
}

// ── calculateOptimalAllocation ───────────────────────────

describe('BaseAllocator.calculateOptimalAllocation', () => {
  it('allocates all deployable to highest APY protocol', () => {
    const protocols = [
      makeMockProtocol('kamino', 0.06, 0),
      makeMockProtocol('drift', 0.08, 0),
      makeMockProtocol('jupiter', 0.05, 0),
    ];
    const allocator = new BaseAllocator(protocols, config);

    const total = 10_000;
    const currentAllocations = new Map([['kamino', 0], ['drift', 0], ['jupiter', 0]]);
    const apyRanking = [
      { protocol: 'drift', apy: 0.08 },
      { protocol: 'kamino', apy: 0.06 },
      { protocol: 'jupiter', apy: 0.05 },
    ];

    const result = allocator.calculateOptimalAllocation(total, currentAllocations, apyRanking);

    // 10000 * 5% buffer = 500, deployable = 9500
    const driftAlloc = result.find(r => r.protocol === 'drift');
    expect(driftAlloc!.targetBalance).toBe(9_500);
    expect(driftAlloc!.action).toBe('deposit');
    expect(driftAlloc!.amount).toBe(9_500);

    // Others should have 0 target
    const kaminoAlloc = result.find(r => r.protocol === 'kamino');
    expect(kaminoAlloc!.targetBalance).toBe(0);
    expect(kaminoAlloc!.action).toBe('none');
  });

  it('sticks with current winner when APY diff is below minDiffBps', () => {
    const protocols = [
      makeMockProtocol('kamino', 0.06, 9_500),
      makeMockProtocol('drift', 0.0605, 0), // only 5bps better, below 50bps threshold
    ];
    const allocator = new BaseAllocator(protocols, config);

    const total = 10_000;
    const currentAllocations = new Map([['kamino', 9_500], ['drift', 0]]);
    const apyRanking = [
      { protocol: 'drift', apy: 0.0605 },
      { protocol: 'kamino', apy: 0.06 },
    ];

    const result = allocator.calculateOptimalAllocation(total, currentAllocations, apyRanking);

    // Should stick with kamino (current winner)
    const kaminoAlloc = result.find(r => r.protocol === 'kamino');
    expect(kaminoAlloc!.targetBalance).toBe(9_500);
    expect(kaminoAlloc!.action).toBe('none');

    const driftAlloc = result.find(r => r.protocol === 'drift');
    expect(driftAlloc!.action).toBe('none');
  });

  it('switches when APY diff exceeds minDiffBps', () => {
    const protocols = [
      makeMockProtocol('kamino', 0.06, 9_500),
      makeMockProtocol('drift', 0.07, 0), // 100bps better > 50bps threshold
    ];
    const allocator = new BaseAllocator(protocols, config);

    const total = 10_000;
    const currentAllocations = new Map([['kamino', 9_500], ['drift', 0]]);
    const apyRanking = [
      { protocol: 'drift', apy: 0.07 },
      { protocol: 'kamino', apy: 0.06 },
    ];

    const result = allocator.calculateOptimalAllocation(total, currentAllocations, apyRanking);

    const driftAlloc = result.find(r => r.protocol === 'drift');
    expect(driftAlloc!.targetBalance).toBe(9_500);
    expect(driftAlloc!.action).toBe('deposit');

    const kaminoAlloc = result.find(r => r.protocol === 'kamino');
    expect(kaminoAlloc!.targetBalance).toBe(0);
    expect(kaminoAlloc!.action).toBe('withdraw');
    expect(kaminoAlloc!.amount).toBe(9_500);
  });

  it('returns empty array when no APY ranking data', () => {
    const protocols = [makeMockProtocol('kamino', 0.06, 0)];
    const allocator = new BaseAllocator(protocols, config);

    const result = allocator.calculateOptimalAllocation(10_000, new Map(), []);
    expect(result).toEqual([]);
  });

  it('respects buffer percentage', () => {
    const protocols = [makeMockProtocol('kamino', 0.06, 0)];
    const allocator = new BaseAllocator(protocols, config);

    const total = 20_000;
    const currentAllocations = new Map([['kamino', 0]]);
    const apyRanking = [{ protocol: 'kamino', apy: 0.06 }];

    const result = allocator.calculateOptimalAllocation(total, currentAllocations, apyRanking);

    // 20000 * 5% = 1000 buffer, deployable = 19000
    const kaminoAlloc = result.find(r => r.protocol === 'kamino');
    expect(kaminoAlloc!.targetBalance).toBe(19_000);
  });

  it('ignores small diffs below 0.01', () => {
    const protocols = [makeMockProtocol('kamino', 0.06, 9_500)];
    const allocator = new BaseAllocator(protocols, config);

    const total = 10_000;
    const currentAllocations = new Map([['kamino', 9_500]]);
    const apyRanking = [{ protocol: 'kamino', apy: 0.06 }];

    const result = allocator.calculateOptimalAllocation(total, currentAllocations, apyRanking);

    const kaminoAlloc = result.find(r => r.protocol === 'kamino');
    expect(kaminoAlloc!.action).toBe('none');
  });
});

// ── getCurrentAllocations ────────────────────────────────

describe('BaseAllocator.getCurrentAllocations', () => {
  it('returns balances from all protocols', async () => {
    const protocols = [
      makeMockProtocol('kamino', 0.06, 5_000),
      makeMockProtocol('drift', 0.05, 3_000),
    ];
    const allocator = new BaseAllocator(protocols, config);

    const allocations = await allocator.getCurrentAllocations();
    expect(allocations.get('kamino')).toBe(5_000);
    expect(allocations.get('drift')).toBe(3_000);
  });

  it('handles protocol errors gracefully', async () => {
    const failProtocol: LendingProtocol = {
      name: 'broken',
      getApy: async () => 0,
      getBalance: async () => { throw new Error('RPC fail'); },
      deposit: async () => '',
      withdraw: async () => '',
    };
    const protocols = [
      makeMockProtocol('kamino', 0.06, 5_000),
      failProtocol,
    ];
    const allocator = new BaseAllocator(protocols, config);

    const allocations = await allocator.getCurrentAllocations();
    expect(allocations.get('kamino')).toBe(5_000);
    expect(allocations.has('broken')).toBe(false); // failed, not included
  });
});

// ── getApyRanking ────────────────────────────────────────

describe('BaseAllocator.getApyRanking', () => {
  it('returns protocols sorted by APY descending', async () => {
    const protocols = [
      makeMockProtocol('kamino', 0.06, 0),
      makeMockProtocol('drift', 0.08, 0),
      makeMockProtocol('jupiter', 0.05, 0),
    ];
    const allocator = new BaseAllocator(protocols, config);

    const ranking = await allocator.getApyRanking();
    expect(ranking[0]!.protocol).toBe('drift');
    expect(ranking[1]!.protocol).toBe('kamino');
    expect(ranking[2]!.protocol).toBe('jupiter');
  });
});
