import type { KaminoMultiplyLending } from '../connectors/defi/kamino-multiply.js';
import type { MarketScanner } from '../core/market-scanner.js';
import type { CapacityInfo, LedgerEvent, RiskAssessment, VaultConfig } from '../types.js';
import { EventType } from '../types.js';
import { createChildLogger } from '../utils/logger.js';
import { round } from '../utils/math.js';
import { getTxFeeInSol } from '../utils/tx-fee.js';
import { BaseAllocator } from './base-allocator.js';

const log = createChildLogger('capital-allocator');

export interface CapitalTargetInput {
  totalUsdc: number;
  currentMultiplyUsdc: number;
  currentLendingUsdc: number;
  bufferPct: number;
  multiplyAvailable: boolean;
  healthRate: number | null;
  alertHealthRate: number | null;
  additionalCapacityUsdc: number | null;
  riskAssessment: RiskAssessment | null;
  rejectRiskScore: number;
}

export interface CapitalAllocationPlan {
  totalUsdc: number;
  bufferAmount: number;
  deployableUsdc: number;
  currentMultiplyUsdc: number;
  currentLendingUsdc: number;
  targetMultiplyUsdc: number;
  targetLendingUsdc: number;
  multiplyDepositBlockedReason: string | null;
}

export function determineCapitalTargets(input: CapitalTargetInput): CapitalAllocationPlan {
  const bufferAmount = round(input.totalUsdc * (input.bufferPct / 100), 6);
  const deployableUsdc = round(Math.max(input.totalUsdc - bufferAmount, 0), 6);

  const riskBlocked =
    !!input.riskAssessment &&
    input.riskAssessment.compositeScore >= input.rejectRiskScore;
  const healthBlocked =
    input.healthRate !== null &&
    input.alertHealthRate !== null &&
    Number.isFinite(input.healthRate) &&
    input.healthRate < input.alertHealthRate;

  let multiplyDepositBlockedReason: string | null = null;
  if (!input.multiplyAvailable) {
    multiplyDepositBlockedReason = 'no_active_multiply';
  } else if (healthBlocked) {
    multiplyDepositBlockedReason = 'multiply_health_below_alert';
  } else if (riskBlocked) {
    multiplyDepositBlockedReason = 'multiply_risk_reject';
  }

  const maxMultiplyUsdc = multiplyDepositBlockedReason
    ? input.currentMultiplyUsdc
    : round(
        input.currentMultiplyUsdc + (input.additionalCapacityUsdc ?? Number.POSITIVE_INFINITY),
        6,
      );

  const targetMultiplyUsdc = input.multiplyAvailable
    ? round(Math.min(deployableUsdc, maxMultiplyUsdc), 6)
    : 0;
  const targetLendingUsdc = round(
    Math.max(deployableUsdc - targetMultiplyUsdc, 0),
    6,
  );

  return {
    totalUsdc: input.totalUsdc,
    bufferAmount,
    deployableUsdc,
    currentMultiplyUsdc: input.currentMultiplyUsdc,
    currentLendingUsdc: input.currentLendingUsdc,
    targetMultiplyUsdc,
    targetLendingUsdc,
    multiplyDepositBlockedReason,
  };
}

export class CapitalAllocator {
  private baseAllocator: BaseAllocator;
  private multiplyAdapters: KaminoMultiplyLending[];
  private config: VaultConfig;
  private marketScanner: MarketScanner | null;
  private rpcUrl: string;

  constructor(
    baseAllocator: BaseAllocator,
    multiplyAdapters: KaminoMultiplyLending[],
    config: VaultConfig,
    marketScanner?: MarketScanner | null,
    rpcUrl?: string,
  ) {
    this.baseAllocator = baseAllocator;
    this.multiplyAdapters = multiplyAdapters;
    this.config = config;
    this.marketScanner = marketScanner ?? null;
    this.rpcUrl = rpcUrl ?? process.env.HELIUS_RPC_URL ?? '';
  }

  private getPrimaryMultiplyAdapter(): KaminoMultiplyLending | null {
    return this.multiplyAdapters[0] ?? null;
  }

  private getRiskAssessment(label: string): RiskAssessment | null {
    return this.marketScanner?.getLatestScans().find((scan) => scan.label === label)?.riskAssessment ?? null;
  }

  private getAdditionalCapacity(capacity: CapacityInfo | null): number | null {
    if (!capacity) return null;
    const remaining = capacity.dailyCapRemaining === null
      ? capacity.remaining
      : Math.min(capacity.remaining, capacity.dailyCapRemaining);
    return round(Math.max(remaining, 0), 6);
  }

  async plan(walletUsdcBalance = 0): Promise<{
    capitalPlan: CapitalAllocationPlan;
    lendingPlan: Awaited<ReturnType<BaseAllocator['planRebalanceToTargetTotal']>>;
    activeMultiply: KaminoMultiplyLending | null;
    effectiveApy: number | null;
    movingAvgApy: number | null;
    healthRate: number | null;
    capacity: CapacityInfo | null;
    riskAssessment: RiskAssessment | null;
  }> {
    const currentAllocations = await this.baseAllocator.getCurrentAllocations();
    const currentLendingUsdc = round(
      Array.from(currentAllocations.values()).reduce((sum, balance) => sum + balance, 0),
      6,
    );

    const activeMultiply = this.getPrimaryMultiplyAdapter();
    let currentMultiplyUsdc = 0;
    let effectiveApy: number | null = null;
    let movingAvgApy: number | null = null;
    let healthRate: number | null = null;
    let capacity: CapacityInfo | null = null;
    let riskAssessment: RiskAssessment | null = null;
    let alertHealthRate: number | null = null;

    if (activeMultiply) {
      const label = activeMultiply.getMultiplyConfig().label;
      const [balance, apy, currentHealth, currentCapacity] = await Promise.all([
        activeMultiply.getBalance(),
        activeMultiply.getApy(),
        activeMultiply.getHealthRate(),
        activeMultiply.getCapacity().catch(() => null),
      ]);
      currentMultiplyUsdc = round(balance, 6);
      effectiveApy = apy;
      healthRate = currentHealth;
      capacity = currentCapacity;
      riskAssessment = this.getRiskAssessment(label);
      movingAvgApy =
        this.marketScanner?.getLatestScans().find((scan) => scan.label === label)?.movingAvg ?? null;
      alertHealthRate = activeMultiply.getMultiplyConfig().alertHealthRate;
    }

    const totalUsdc = round(
      currentLendingUsdc + currentMultiplyUsdc + walletUsdcBalance,
      6,
    );
    const capitalPlan = determineCapitalTargets({
      totalUsdc,
      currentMultiplyUsdc,
      currentLendingUsdc,
      bufferPct: this.config.lending.bufferPct,
      multiplyAvailable: !!activeMultiply,
      healthRate,
      alertHealthRate,
      additionalCapacityUsdc: this.getAdditionalCapacity(capacity),
      riskAssessment,
      rejectRiskScore: this.marketScanner?.getRejectThreshold() ?? 90,
    });

    const lendingPlan = await this.baseAllocator.planRebalanceToTargetTotal(
      capitalPlan.targetLendingUsdc,
    );

    log.info(
      {
        totalUsdc,
        walletUsdcBalance,
        currentLendingUsdc,
        currentMultiplyUsdc,
        targetLendingUsdc: capitalPlan.targetLendingUsdc,
        targetMultiplyUsdc: capitalPlan.targetMultiplyUsdc,
        bufferAmount: capitalPlan.bufferAmount,
        multiplyLabel: activeMultiply?.getMultiplyConfig().label ?? null,
        effectiveApy: effectiveApy === null ? null : round(effectiveApy * 100, 2),
        movingAvgApy: movingAvgApy === null ? null : round(movingAvgApy * 100, 2),
        healthRate,
        capacityRemaining: capacity?.remaining ?? null,
        riskScore: riskAssessment?.compositeScore ?? null,
        multiplyDepositBlockedReason: capitalPlan.multiplyDepositBlockedReason,
      },
      'Capital allocation plan',
    );

    return {
      capitalPlan,
      lendingPlan,
      activeMultiply,
      effectiveApy,
      movingAvgApy,
      healthRate,
      capacity,
      riskAssessment,
    };
  }

  async rebalance(walletUsdcBalance = 0): Promise<{ txSigs: string[]; events: LedgerEvent[] }> {
    const {
      capitalPlan,
      lendingPlan,
      activeMultiply,
    } = await this.plan(walletUsdcBalance);

    const txSigs: string[] = [];
    const events: LedgerEvent[] = [];

    const multiplyDelta = round(
      capitalPlan.targetMultiplyUsdc - capitalPlan.currentMultiplyUsdc,
      6,
    );
    const lendingActionNeeded = lendingPlan.some((a) => a.action !== 'none');
    const multiplyActionNeeded = Math.abs(multiplyDelta) > 0.01;

    if (!lendingActionNeeded && !multiplyActionNeeded) {
      log.info('No capital rebalance needed');
      return { txSigs, events };
    }

    log.info(
      {
        multiplyDelta,
        lendingActions: lendingPlan.filter((a) => a.action !== 'none'),
      },
      'Starting capital rebalance',
    );

    const lendingWithdrawals = lendingPlan.filter((a) => a.action === 'withdraw');
    if (lendingWithdrawals.length > 0) {
      const result = await this.baseAllocator.executePlan(lendingWithdrawals, ['withdraw']);
      txSigs.push(...result.txSigs);
      events.push(...result.events);
    }

    if (activeMultiply && multiplyDelta < -0.01) {
      const amount = round(Math.abs(multiplyDelta), 6);
      try {
        log.info(
          { label: activeMultiply.getMultiplyConfig().label, amount },
          'Withdrawing from Multiply',
        );
        const txSig = await activeMultiply.withdraw(amount);
        txSigs.push(txSig);

        const feeSol = this.rpcUrl ? await getTxFeeInSol(this.rpcUrl, txSig) : 0;
        events.push({
          timestamp: new Date().toISOString(),
          eventType: EventType.WITHDRAW,
          amount,
          asset: 'USDC',
          txHash: txSig,
          fee: feeSol,
          feeAsset: 'SOL',
          sourceProtocol: activeMultiply.name,
          metadata: {
            action: 'capital_rebalance_multiply_withdraw',
            previousBalance: capitalPlan.currentMultiplyUsdc,
          },
        });
      } catch (err) {
        log.error(
          { label: activeMultiply.getMultiplyConfig().label, amount, error: err },
          'Multiply withdraw failed',
        );
        events.push({
          timestamp: new Date().toISOString(),
          eventType: EventType.ALERT,
          amount,
          asset: 'USDC',
          sourceProtocol: activeMultiply.name,
          metadata: {
            action: 'capital_rebalance_multiply_withdraw_failed',
            error: String(err),
          },
        });
      }
    }

    if (activeMultiply && multiplyDelta > 0.01) {
      const amount = round(multiplyDelta, 6);
      try {
        log.info(
          { label: activeMultiply.getMultiplyConfig().label, amount },
          'Depositing to Multiply',
        );
        const txSig = await activeMultiply.deposit(amount);
        txSigs.push(txSig);

        const feeSol = this.rpcUrl ? await getTxFeeInSol(this.rpcUrl, txSig) : 0;
        events.push({
          timestamp: new Date().toISOString(),
          eventType: EventType.DEPOSIT,
          amount,
          asset: 'USDC',
          txHash: txSig,
          fee: feeSol,
          feeAsset: 'SOL',
          sourceProtocol: activeMultiply.name,
          metadata: {
            action: 'capital_rebalance_multiply_deposit',
            previousBalance: capitalPlan.currentMultiplyUsdc,
          },
        });
      } catch (err) {
        log.error(
          { label: activeMultiply.getMultiplyConfig().label, amount, error: err },
          'Multiply deposit failed',
        );
        events.push({
          timestamp: new Date().toISOString(),
          eventType: EventType.ALERT,
          amount,
          asset: 'USDC',
          sourceProtocol: activeMultiply.name,
          metadata: {
            action: 'capital_rebalance_multiply_deposit_failed',
            error: String(err),
          },
        });
      }
    }

    const lendingDeposits = lendingPlan.filter((a) => a.action === 'deposit');
    if (lendingDeposits.length > 0) {
      const result = await this.baseAllocator.executePlan(lendingDeposits, ['deposit']);
      txSigs.push(...result.txSigs);
      events.push(...result.events);
    }

    log.info(
      {
        txCount: txSigs.length,
        eventCount: events.length,
      },
      'Capital rebalance complete',
    );

    return { txSigs, events };
  }
}
