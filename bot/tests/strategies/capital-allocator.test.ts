import { describe, expect, it, vi } from 'vitest';
import { CapitalAllocator, determineCapitalTargets } from '../../src/strategies/capital-allocator.js';
import type { BaseAllocator } from '../../src/strategies/base-allocator.js';
import type { CapacityInfo, VaultConfig } from '../../src/types.js';

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
  lending: {
    protocols: ['kamino', 'jupiter'],
    bufferPct: 5,
    maxProtocolAllocationPct: 60,
  },
};

const ampleCapacity: CapacityInfo = {
  depositLimit: 10_000,
  totalSupply: 5_000,
  remaining: 5_000,
  utilizationRatio: 0.5,
  dailyCapRemaining: null,
};

describe('determineCapitalTargets', () => {
  it('allocates all deployable capital to Multiply when capacity is sufficient', () => {
    const plan = determineCapitalTargets({
      totalUsdc: 1_000,
      currentMultiplyUsdc: 400,
      currentLendingUsdc: 100,
      bufferPct: 5,
      multiplyAvailable: true,
      healthRate: Infinity,
      alertHealthRate: 1.1,
      additionalCapacityUsdc: 5_000,
      riskAssessment: null,
      rejectRiskScore: 90,
    });

    expect(plan.bufferAmount).toBe(50);
    expect(plan.targetMultiplyUsdc).toBe(950);
    expect(plan.targetLendingUsdc).toBe(0);
    expect(plan.multiplyDepositBlockedReason).toBeNull();
  });

  it('uses lending only for overflow when Multiply capacity is insufficient', () => {
    const plan = determineCapitalTargets({
      totalUsdc: 1_000,
      currentMultiplyUsdc: 400,
      currentLendingUsdc: 100,
      bufferPct: 5,
      multiplyAvailable: true,
      healthRate: Infinity,
      alertHealthRate: 1.1,
      additionalCapacityUsdc: 200,
      riskAssessment: null,
      rejectRiskScore: 90,
    });

    expect(plan.targetMultiplyUsdc).toBe(600);
    expect(plan.targetLendingUsdc).toBe(350);
  });

  it('blocks new Multiply deposits when health is below alert threshold', () => {
    const plan = determineCapitalTargets({
      totalUsdc: 1_000,
      currentMultiplyUsdc: 400,
      currentLendingUsdc: 100,
      bufferPct: 5,
      multiplyAvailable: true,
      healthRate: 1.05,
      alertHealthRate: 1.1,
      additionalCapacityUsdc: 5_000,
      riskAssessment: null,
      rejectRiskScore: 90,
    });

    expect(plan.targetMultiplyUsdc).toBe(400);
    expect(plan.targetLendingUsdc).toBe(550);
    expect(plan.multiplyDepositBlockedReason).toBe('multiply_health_below_alert');
  });

  it('blocks new Multiply deposits when risk score is above the risk-off threshold', () => {
    const plan = determineCapitalTargets({
      totalUsdc: 1_000,
      currentMultiplyUsdc: 400,
      currentLendingUsdc: 100,
      bufferPct: 5,
      multiplyAvailable: true,
      healthRate: 1.2,
      alertHealthRate: 1.1,
      additionalCapacityUsdc: 5_000,
      riskAssessment: {
        label: 'ONyc/USDC',
        compositeScore: 80,
        dimensions: {
          depegRisk: 80,
          liquidationProximity: 10,
          exitLiquidity: 5,
          reservePressure: 20,
        },
        details: {
          depegRisk: {
            collPriceUsd: 1,
            debtPriceUsd: 1,
            marketRate: 1,
            expectedRate: 1,
            deviationBps: 0,
            spotScore: 0,
            volatility24hBps: 0,
            volatility24hScore: 0,
            volatilitySampleCount: 0,
            tailRisk7dBps: 0,
            tailRisk7dScore: 0,
            tailRiskSampleCount: 0,
          },
          liquidationProximity: {
            liquidationLtv: 0.8,
            targetHealthRate: 1.2,
            targetLeverage: 2.1,
            marketRate: 1,
            simulatedHealthRate: 1.2,
            stressedMarketRate: 1,
            stressedHealthRate: 1.1,
            baseScore: 10,
            stressScore: 15,
          },
          exitLiquidity: {
            assumedExitUsd: 10_000,
            quoteInputAmount: 10_000,
            priceImpactPct: 0.1,
            slippageBps: 10,
          },
          reservePressure: {
            collateralUtilizationRatio: 0.4,
            debtUtilizationRatio: 0.3,
            weightedUtilizationRatio: 0.35,
            utilizationScore: 10,
            depositLimit: 10_000,
            totalSupply: 5_000,
            remainingCapacity: 5_000,
            capacityRatio: 0.5,
            capacityPenalty: 0,
            marketTvlUsd: 10_000_000,
            tvlPenalty: 0,
          },
        },
        riskPenalty: 0,
        targetHealthRate: 1.2,
        maxPositionCap: 2_500,
        alertLevel: 'critical',
        assessedAt: Date.now(),
      },
      rejectRiskScore: 75,
    });

    expect(plan.targetMultiplyUsdc).toBe(400);
    expect(plan.targetLendingUsdc).toBe(550);
    expect(plan.multiplyDepositBlockedReason).toBe('multiply_risk_reject');
  });
});

describe('CapitalAllocator.rebalance', () => {
  it('withdraws from lending and then deposits to Multiply', async () => {
    const baseAllocator = {
      getCurrentAllocations: vi.fn().mockResolvedValue(new Map([['kamino', 100]])),
      planRebalanceToTargetTotal: vi.fn().mockResolvedValue([
        {
          protocol: 'kamino',
          currentBalance: 100,
          targetBalance: 0,
          action: 'withdraw' as const,
          amount: 100,
        },
      ]),
      executePlan: vi.fn().mockResolvedValue({
        txSigs: ['lending-withdraw'],
        events: [],
      }),
    } as unknown as BaseAllocator;

    const multiply = {
      name: 'kamino-multiply:ONyc/USDC',
      getBalance: vi.fn().mockResolvedValue(0),
      getApy: vi.fn().mockResolvedValue(0.12),
      getHealthRate: vi.fn().mockResolvedValue(Infinity),
      getCapacity: vi.fn().mockResolvedValue(ampleCapacity),
      getMultiplyConfig: vi.fn().mockReturnValue({
        label: 'ONyc/USDC',
        alertHealthRate: 1.1,
      }),
      deposit: vi.fn().mockResolvedValue('multiply-deposit'),
      withdraw: vi.fn(),
    };

    const allocator = new CapitalAllocator(
      baseAllocator,
      [multiply as any],
      config,
      null,
      '',
    );

    const result = await allocator.rebalance(50);

    expect(baseAllocator.planRebalanceToTargetTotal).toHaveBeenCalledWith(0);
    expect(baseAllocator.executePlan).toHaveBeenCalledTimes(1);
    expect(multiply.deposit).toHaveBeenCalledWith(142.5);
    expect(result.txSigs).toEqual(['lending-withdraw', 'multiply-deposit']);
  });
});
