import { describe, it, expect } from 'vitest';
import { LendingRiskScorer, DEFAULT_LENDING_RISK_CONFIG } from '../../src/risk/lending-risk-scorer.js';

const meta = {
  kamino: { auditCount: 3, ageMonths: 24, incidents: 0 },
  jupiter: { auditCount: 2, ageMonths: 18, incidents: 0 },
  drift: { auditCount: 2, ageMonths: 24, incidents: 1, disabled: true as const },
  newProtocol: { auditCount: 0, ageMonths: 3, incidents: 0 },
};

describe('LendingRiskScorer', () => {
  it('gives low risk score to mature, large protocol', () => {
    const scorer = new LendingRiskScorer(meta);
    const result = scorer.assess('kamino', 200_000_000, 0.65, 5_000);

    // Large TVL, mature, no incidents, low concentration
    expect(result.compositeScore).toBeLessThan(30);
    expect(result.riskPenalty).toBeLessThan(0.01);
  });

  it('gives higher risk score to protocol with incident history', () => {
    const scorer = new LendingRiskScorer(meta);
    const resultDrift = scorer.assess('drift', 100_000_000, 0.5, 5_000);
    const resultKamino = scorer.assess('kamino', 100_000_000, 0.5, 5_000);

    expect(resultDrift.compositeScore).toBeGreaterThan(resultKamino.compositeScore);
    expect(resultDrift.dimensions.incidentHistory).toBe(50); // 1 incident
    expect(resultKamino.dimensions.incidentHistory).toBe(0);
  });

  it('penalizes new, unaudited protocol', () => {
    const scorer = new LendingRiskScorer(meta);
    const result = scorer.assess('newProtocol', 10_000_000, 0.3, 1_000);

    // Small TVL, young, no audits
    expect(result.compositeScore).toBeGreaterThan(40);
    expect(result.dimensions.protocolMaturity).toBe(80); // 40(no audit) + 40(young)
  });

  it('penalizes high reserve utilization', () => {
    const scorer = new LendingRiskScorer(meta);
    const low = scorer.assess('kamino', 200_000_000, 0.3, 5_000);
    const high = scorer.assess('kamino', 200_000_000, 0.9, 5_000);

    expect(high.dimensions.reserveUtilization).toBeGreaterThan(low.dimensions.reserveUtilization);
    expect(high.compositeScore).toBeGreaterThan(low.compositeScore);
  });

  it('penalizes deposit concentration', () => {
    const scorer = new LendingRiskScorer(meta);
    const low = scorer.assess('kamino', 200_000_000, 0.5, 1_000); // tiny vs TVL
    const high = scorer.assess('kamino', 200_000_000, 0.5, 4_000_000); // 2% of TVL

    expect(high.dimensions.depositConcentration).toBeGreaterThan(low.dimensions.depositConcentration);
  });

  it('uses conservative defaults for unknown protocol', () => {
    const scorer = new LendingRiskScorer(meta);
    const result = scorer.assess('unknown', null, null, 5_000);

    // All dimensions use defaults (50-60)
    expect(result.compositeScore).toBeGreaterThan(30);
    expect(result.dimensions.tvlScale).toBe(50);
    expect(result.dimensions.protocolMaturity).toBe(60);
    expect(result.dimensions.reserveUtilization).toBe(50);
  });

  it('adjustApyRanking reorders by effective APY', () => {
    const scorer = new LendingRiskScorer(meta);
    const apyRanking = [
      { protocol: 'drift', apy: 0.07 },   // slightly higher raw APY but risky
      { protocol: 'kamino', apy: 0.06 },   // safer
    ];

    const protocolData = new Map([
      ['drift', { tvl: 20_000_000, utilization: 0.85, deposit: 5_000 }],
      ['kamino', { tvl: 200_000_000, utilization: 0.5, deposit: 5_000 }],
    ]);

    const adjusted = scorer.adjustApyRanking(apyRanking, protocolData);

    // Kamino should have higher effective APY because Drift has
    // incident penalty + lower TVL + higher utilization
    expect(adjusted[0]!.protocol).toBe('kamino');
    expect(adjusted[0]!.effectiveApy).toBeGreaterThan(adjusted[1]!.effectiveApy);
    // Drift penalty should be significant
    expect(adjusted.find(a => a.protocol === 'drift')!.riskPenalty).toBeGreaterThan(0.01);
  });

  it('risk penalty is 0 for very low scores', () => {
    const scorer = new LendingRiskScorer(meta);
    // Giant TVL, mature, no incidents, tiny deposit
    const result = scorer.assess('kamino', 500_000_000, 0.2, 100);
    expect(result.riskPenalty).toBe(0);
  });
});
