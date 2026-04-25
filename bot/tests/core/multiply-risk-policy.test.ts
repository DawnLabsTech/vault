import { describe, expect, it } from 'vitest';
import { determineMultiplyRiskAction } from '../../src/core/multiply-risk-policy.js';
import type { RiskAssessment } from '../../src/types.js';

function makeRiskAssessment(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    label: 'ONyc/USDC',
    compositeScore: 40,
    dimensions: {
      depegRisk: 40,
      liquidationProximity: 20,
      exitLiquidity: 10,
      reservePressure: 15,
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
        targetHealthRate: 1.15,
        targetLeverage: 2.3,
        marketRate: 1,
        simulatedHealthRate: 1.2,
        stressedMarketRate: 1,
        stressedHealthRate: 1.15,
        baseScore: 20,
        stressScore: 25,
      },
      exitLiquidity: {
        assumedExitUsd: 10_000,
        quoteInputAmount: 10_000,
        priceImpactPct: 0.2,
        slippageBps: 20,
      },
      reservePressure: {
        collateralUtilizationRatio: 0.5,
        debtUtilizationRatio: 0.4,
        weightedUtilizationRatio: 0.45,
        utilizationScore: 10,
        depositLimit: 10_000_000,
        totalSupply: 5_000_000,
        remainingCapacity: 5_000_000,
        capacityRatio: 0.5,
        capacityPenalty: 0,
        marketTvlUsd: 50_000_000,
        tvlPenalty: 0,
      },
    },
    riskPenalty: 0,
    targetHealthRate: 1.2,
    maxPositionCap: 5_000,
    alertLevel: 'normal',
    assessedAt: Date.now(),
    ...overrides,
  };
}

describe('determineMultiplyRiskAction', () => {
  it('returns no action below thresholds', () => {
    const action = determineMultiplyRiskAction({
      currentBalance: 4_000,
      healthRate: 1.25,
      alertHealthRate: 1.1,
      emergencyHealthRate: 1.05,
      riskAssessment: makeRiskAssessment({ compositeScore: 50, maxPositionCap: 8_000 }),
      rejectRiskScore: 75,
      emergencyRiskScore: 90,
    });

    expect(action).toEqual({ type: 'none' });
  });

  it('reduces to the dynamic max position cap when risk is elevated', () => {
    const action = determineMultiplyRiskAction({
      currentBalance: 6_000,
      healthRate: 1.25,
      alertHealthRate: 1.1,
      emergencyHealthRate: 1.05,
      riskAssessment: makeRiskAssessment({ compositeScore: 80, maxPositionCap: 2_500 }),
      rejectRiskScore: 75,
      emergencyRiskScore: 90,
    });

    expect(action).toMatchObject({
      type: 'reduce',
      reason: 'risk_soft',
      amount: 3_500,
      targetBalance: 2_500,
      healthReductionAmount: 0,
      riskReductionAmount: 3_500,
    });
  });

  it('chooses the larger reduction when health and risk both request soft deleverage', () => {
    const action = determineMultiplyRiskAction({
      currentBalance: 4_000,
      healthRate: 1.08,
      alertHealthRate: 1.1,
      emergencyHealthRate: 1.05,
      riskAssessment: makeRiskAssessment({ compositeScore: 82, maxPositionCap: 3_500 }),
      rejectRiskScore: 75,
      emergencyRiskScore: 90,
    });

    expect(action).toMatchObject({
      type: 'reduce',
      reason: 'health_and_risk_soft',
      amount: 800,
      targetBalance: 3_200,
      healthReductionAmount: 800,
      riskReductionAmount: 500,
    });
  });

  it('forces emergency exit when risk reaches the emergency threshold', () => {
    const action = determineMultiplyRiskAction({
      currentBalance: 3_000,
      healthRate: 1.22,
      alertHealthRate: 1.1,
      emergencyHealthRate: 1.05,
      riskAssessment: makeRiskAssessment({ compositeScore: 92 }),
      rejectRiskScore: 75,
      emergencyRiskScore: 90,
    });

    expect(action).toEqual({
      type: 'emergency',
      reason: 'risk_emergency',
      amount: 3_000,
    });
  });

  it('forces emergency exit on critical borrow rate spike', () => {
    const action = determineMultiplyRiskAction({
      currentBalance: 5_000,
      healthRate: 1.25,
      alertHealthRate: 1.1,
      emergencyHealthRate: 1.05,
      riskAssessment: makeRiskAssessment({ compositeScore: 40 }),
      rejectRiskScore: 75,
      emergencyRiskScore: 90,
      borrowRateSpike: { level: 'critical' },
    });

    expect(action).toEqual({
      type: 'emergency',
      reason: 'borrow_rate_spike_emergency',
      amount: 5_000,
    });
  });

  it('reduces 20% on warning borrow rate spike', () => {
    const action = determineMultiplyRiskAction({
      currentBalance: 10_000,
      healthRate: 1.25,
      alertHealthRate: 1.1,
      emergencyHealthRate: 1.05,
      riskAssessment: makeRiskAssessment({ compositeScore: 40, maxPositionCap: 20_000 }),
      rejectRiskScore: 75,
      emergencyRiskScore: 90,
      borrowRateSpike: { level: 'warning' },
    });

    expect(action).toMatchObject({
      type: 'reduce',
      reason: 'borrow_rate_spike_soft',
      amount: 2_000,
      targetBalance: 8_000,
    });
  });
});
