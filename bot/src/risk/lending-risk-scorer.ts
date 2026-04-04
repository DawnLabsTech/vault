/**
 * Lending Protocol Risk Scorer
 *
 * Evaluates lending protocols on 5 dimensions to produce a risk penalty
 * that is subtracted from raw APY, making risky protocols less attractive.
 *
 * Dimensions:
 *   D1: TVL Scale (30%) — smaller TVL = higher risk
 *   D2: Protocol Maturity (20%) — audit count, age, track record
 *   D3: Reserve Utilization (25%) — high utilization = withdrawal risk
 *   D4: Deposit Concentration (15%) — our deposits as % of protocol TVL
 *   D5: Incident History (10%) — past hacks/exploits
 */
import { createChildLogger } from '../utils/logger.js';
import type { LendingProtocolMeta, LendingRiskScorerConfig } from '../types.js';

const log = createChildLogger('lending-risk-scorer');

export const DEFAULT_LENDING_RISK_CONFIG: LendingRiskScorerConfig = {
  weights: {
    tvlScale: 0.30,
    protocolMaturity: 0.20,
    reserveUtilization: 0.25,
    depositConcentration: 0.15,
    incidentHistory: 0.10,
  },
  tvlSafeThreshold: 50_000_000, // $50M
  maxRiskPenalty: 0.03, // 3% APY
};

function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}

export interface LendingRiskAssessment {
  protocol: string;
  compositeScore: number; // 0-100 (higher = riskier)
  riskPenalty: number; // APY penalty (decimal)
  dimensions: {
    tvlScale: number;
    protocolMaturity: number;
    reserveUtilization: number;
    depositConcentration: number;
    incidentHistory: number;
  };
}

export class LendingRiskScorer {
  private config: LendingRiskScorerConfig;
  private protocolMeta: Record<string, LendingProtocolMeta>;

  constructor(
    protocolMeta: Record<string, LendingProtocolMeta> = {},
    config?: Partial<LendingRiskScorerConfig>,
  ) {
    this.config = { ...DEFAULT_LENDING_RISK_CONFIG, ...config };
    this.protocolMeta = protocolMeta;
  }

  /**
   * Assess a lending protocol's risk and return APY penalty.
   *
   * @param name - protocol name (e.g. 'kamino', 'jupiter')
   * @param tvl - protocol's total TVL in USD (null if unavailable)
   * @param utilization - reserve utilization ratio 0-1 (null if unavailable)
   * @param ourDeposit - our deposit amount in USD
   */
  assess(
    name: string,
    tvl: number | null,
    utilization: number | null,
    ourDeposit: number,
  ): LendingRiskAssessment {
    const meta = this.protocolMeta[name];
    const w = this.config.weights;

    // D1: TVL Scale
    const d1 = tvl !== null
      ? clamp((1 - tvl / this.config.tvlSafeThreshold) * 100)
      : 50; // conservative default

    // D2: Protocol Maturity
    const d2 = this.calcMaturityScore(meta);

    // D3: Reserve Utilization
    const d3 = utilization !== null
      ? clamp((utilization / 0.95) * 100) // 95% utilization = score 100
      : 50;

    // D4: Deposit Concentration
    let d4 = 50; // default
    if (tvl !== null && tvl > 0 && ourDeposit > 0) {
      const concentrationPct = (ourDeposit / tvl) * 100;
      d4 = clamp(concentrationPct * 50); // 2% = score 100
    }

    // D5: Incident History
    const d5 = meta
      ? clamp(meta.incidents * 50) // 1 incident = 50, 2+ = 100
      : 30; // unknown = moderate risk

    const compositeScore = clamp(
      w.tvlScale * d1 +
      w.protocolMaturity * d2 +
      w.reserveUtilization * d3 +
      w.depositConcentration * d4 +
      w.incidentHistory * d5,
    );

    // Map score to APY penalty: 0 at score<=10, linear to maxRiskPenalty at score=100
    const riskPenalty = compositeScore <= 10
      ? 0
      : ((compositeScore - 10) / 90) * this.config.maxRiskPenalty;

    log.debug(
      {
        protocol: name,
        composite: compositeScore.toFixed(1),
        d1: d1.toFixed(1),
        d2: d2.toFixed(1),
        d3: d3.toFixed(1),
        d4: d4.toFixed(1),
        d5: d5.toFixed(1),
        penalty: `${(riskPenalty * 100).toFixed(2)}%`,
      },
      'Lending risk assessment',
    );

    return {
      protocol: name,
      compositeScore,
      riskPenalty,
      dimensions: {
        tvlScale: d1,
        protocolMaturity: d2,
        reserveUtilization: d3,
        depositConcentration: d4,
        incidentHistory: d5,
      },
    };
  }

  /**
   * Compute risk-adjusted APY rankings.
   * Returns protocols sorted by effective APY (raw - penalty) descending.
   */
  adjustApyRanking(
    apyRanking: { protocol: string; apy: number }[],
    protocolData: Map<string, { tvl: number | null; utilization: number | null; deposit: number }>,
  ): { protocol: string; rawApy: number; effectiveApy: number; riskPenalty: number }[] {
    const adjusted = apyRanking.map(({ protocol, apy }) => {
      const data = protocolData.get(protocol) ?? { tvl: null, utilization: null, deposit: 0 };
      const assessment = this.assess(protocol, data.tvl, data.utilization, data.deposit);
      return {
        protocol,
        rawApy: apy,
        effectiveApy: Math.max(apy - assessment.riskPenalty, 0),
        riskPenalty: assessment.riskPenalty,
      };
    });

    adjusted.sort((a, b) => b.effectiveApy - a.effectiveApy);
    return adjusted;
  }

  private calcMaturityScore(meta?: LendingProtocolMeta): number {
    if (!meta) return 60; // unknown protocol = elevated risk

    let score = 0;

    // Audit count: 0 = 40, 1 = 20, 2+ = 0
    score += meta.auditCount === 0 ? 40 : meta.auditCount === 1 ? 20 : 0;

    // Age: <6m = 40, <12m = 20, <24m = 10, 24m+ = 0
    score += meta.ageMonths < 6 ? 40
      : meta.ageMonths < 12 ? 20
        : meta.ageMonths < 24 ? 10
          : 0;

    // Cap maturity score to 0-100
    return clamp(score);
  }
}
