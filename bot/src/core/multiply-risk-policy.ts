import type { RiskAssessment } from '../types.js';
import { round } from '../utils/math.js';

export type MultiplyRiskActionReason =
  | 'health_emergency'
  | 'risk_emergency'
  | 'health_and_risk_emergency'
  | 'borrow_rate_spike_emergency'
  | 'health_soft'
  | 'risk_soft'
  | 'health_and_risk_soft'
  | 'borrow_rate_spike_soft';

export type MultiplyRiskAction =
  | { type: 'none' }
  | {
      type: 'emergency';
      reason: MultiplyRiskActionReason;
      amount: number;
    }
  | {
      type: 'reduce';
      reason: MultiplyRiskActionReason;
      amount: number;
      targetBalance: number;
      healthReductionAmount: number;
      riskReductionAmount: number;
    };

export interface MultiplyRiskPolicyInput {
  currentBalance: number;
  healthRate: number;
  alertHealthRate: number;
  emergencyHealthRate: number;
  riskAssessment: RiskAssessment | null;
  rejectRiskScore: number;
  emergencyRiskScore: number;
  /** Borrow rate spike detection result */
  borrowRateSpike?: { level: 'warning' | 'critical' };
}

/**
 * Convert health/risk inputs into an explicit position-management action.
 * Risk does not affect APY; it only gates new allocation and size reduction.
 */
export function determineMultiplyRiskAction(
  input: MultiplyRiskPolicyInput,
): MultiplyRiskAction {
  const currentBalance = round(Math.max(input.currentBalance, 0), 6);
  if (currentBalance <= 0.01) {
    return { type: 'none' };
  }

  const riskScore = input.riskAssessment?.compositeScore ?? null;
  const riskCap = input.riskAssessment?.maxPositionCap ?? null;

  const healthEmergency =
    Number.isFinite(input.healthRate) &&
    input.healthRate < input.emergencyHealthRate;
  const riskEmergency =
    riskScore !== null &&
    riskScore >= input.emergencyRiskScore;
  const borrowRateEmergency =
    input.borrowRateSpike?.level === 'critical';

  if (healthEmergency || riskEmergency || borrowRateEmergency) {
    return {
      type: 'emergency',
      reason: borrowRateEmergency
        ? 'borrow_rate_spike_emergency'
        : healthEmergency && riskEmergency
          ? 'health_and_risk_emergency'
          : healthEmergency
            ? 'health_emergency'
            : 'risk_emergency',
      amount: currentBalance,
    };
  }

  const healthReductionAmount =
    Number.isFinite(input.healthRate) && input.healthRate < input.alertHealthRate
      ? round(currentBalance * 0.2, 6)
      : 0;
  const riskReductionAmount =
    riskScore !== null &&
    riskScore >= input.rejectRiskScore &&
    riskCap !== null
      ? round(Math.max(currentBalance - riskCap, 0), 6)
      : 0;
  const borrowRateReductionAmount =
    input.borrowRateSpike?.level === 'warning'
      ? round(currentBalance * 0.2, 6)
      : 0;

  const amount = round(Math.max(healthReductionAmount, riskReductionAmount, borrowRateReductionAmount), 6);
  if (amount <= 0.01) {
    return { type: 'none' };
  }

  const targetBalance = round(Math.max(currentBalance - amount, 0), 6);

  const reason: MultiplyRiskActionReason =
    borrowRateReductionAmount > 0 && borrowRateReductionAmount >= Math.max(healthReductionAmount, riskReductionAmount)
      ? 'borrow_rate_spike_soft'
      : healthReductionAmount > 0 && riskReductionAmount > 0
        ? 'health_and_risk_soft'
        : healthReductionAmount > 0
          ? 'health_soft'
          : 'risk_soft';

  return {
    type: 'reduce',
    reason,
    amount,
    targetBalance,
    healthReductionAmount,
    riskReductionAmount,
  };
}
