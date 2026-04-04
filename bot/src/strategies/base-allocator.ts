import type { LendingProtocol, LedgerEvent, VaultConfig } from '../types.js';
import { EventType } from '../types.js';
import { createChildLogger } from '../utils/logger.js';
import { round } from '../utils/math.js';
import { getTxFeeInSol } from '../utils/tx-fee.js';

const log = createChildLogger('base-allocator');

export interface AllocationResult {
  protocol: string;
  currentBalance: number;
  targetBalance: number;
  action: 'deposit' | 'withdraw' | 'none';
  amount: number;
}

export class BaseAllocator {
  private protocols: Map<string, LendingProtocol>;
  private config: VaultConfig;
  private rpcUrl: string;

  constructor(protocols: LendingProtocol[], config: VaultConfig, rpcUrl?: string) {
    this.protocols = new Map(protocols.map((p) => [p.name, p]));
    this.config = config;
    this.rpcUrl = rpcUrl ?? process.env.HELIUS_RPC_URL ?? '';
  }

  /**
   * Hot-swap a protocol adapter (used by market scanner for multiply switching).
   * Removes the old adapter and adds the new one.
   */
  replaceProtocol(oldName: string, newProtocol: LendingProtocol): void {
    this.protocols.delete(oldName);
    this.protocols.set(newProtocol.name, newProtocol);
    log.info({ removed: oldName, added: newProtocol.name }, 'Protocol adapter replaced');
  }

  /** Get current USDC balance from each lending protocol */
  async getCurrentAllocations(): Promise<Map<string, number>> {
    const allocations = new Map<string, number>();
    const results = await Promise.allSettled(
      Array.from(this.protocols.entries()).map(async ([name, protocol]) => {
        const balance = await protocol.getBalance();
        return { name, balance };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allocations.set(result.value.name, result.value.balance);
      } else {
        log.error({ error: result.reason }, 'Failed to fetch balance from protocol');
      }
    }

    return allocations;
  }

  /** Get all protocols sorted by APY descending */
  async getApyRanking(): Promise<{ protocol: string; apy: number }[]> {
    const results = await Promise.allSettled(
      Array.from(this.protocols.entries()).map(async ([name, protocol]) => {
        const apy = await protocol.getApy();
        return { protocol: name, apy };
      }),
    );

    const ranking: { protocol: string; apy: number }[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        ranking.push(result.value);
      }
    }

    ranking.sort((a, b) => b.apy - a.apy);
    return ranking;
  }

  private getRankingWithFallback(
    apyRanking: { protocol: string; apy: number }[],
  ): { protocol: string; apy: number }[] {
    if (apyRanking.length > 0) {
      return apyRanking;
    }
    return Array.from(this.protocols.keys()).map((protocol) => ({ protocol, apy: 0 }));
  }

  private calculateAllocationForDeployable(
    deployable: number,
    currentAllocations: Map<string, number>,
    apyRanking: { protocol: string; apy: number }[],
  ): AllocationResult[] {
    const ranking = this.getRankingWithFallback(apyRanking);
    if (ranking.length === 0) {
      return [];
    }

    const maxAllocPct = this.config.lending.maxProtocolAllocationPct ?? 100;
    const maxPerProtocol = round(deployable * (maxAllocPct / 100), 6);

    let currentWinner = '';
    let currentWinnerBalance = 0;
    for (const [name, balance] of currentAllocations) {
      if (balance > currentWinnerBalance) {
        currentWinner = name;
        currentWinnerBalance = balance;
      }
    }

    const bestProtocol = ranking[0]!.protocol;
    const bestApy = ranking[0]!.apy;
    const currentWinnerApy =
      ranking.find((r) => r.protocol === currentWinner)?.apy ?? 0;

    const minDiffBps = this.config.thresholds.lendingRebalanceMinDiffBps;
    const apyDiffBps = (bestApy - currentWinnerApy) * 10_000;
    const primaryProtocol =
      currentWinner && apyDiffBps < minDiffBps ? currentWinner : bestProtocol;

    const targetBalances = new Map<string, number>();
    let remaining = deployable;

    const sortedProtocols = [...ranking].sort((a, b) => {
      if (a.protocol === primaryProtocol) return -1;
      if (b.protocol === primaryProtocol) return 1;
      return b.apy - a.apy;
    });

    for (const { protocol } of sortedProtocols) {
      const allocation = round(Math.min(remaining, maxPerProtocol), 6);
      targetBalances.set(protocol, allocation);
      remaining = round(remaining - allocation, 6);
      if (remaining <= 0.01) break;
    }

    log.info(
      {
        bestProtocol,
        bestApy: round(bestApy * 100, 2),
        currentWinner,
        currentWinnerApy: round(currentWinnerApy * 100, 2),
        apyDiffBps: round(apyDiffBps, 1),
        minDiffBps,
        primaryProtocol,
        maxAllocPct,
        deployable,
        targetBalances: Object.fromEntries(targetBalances),
      },
      'Lending allocation calculation',
    );

    const protocols = new Set([
      ...Array.from(this.protocols.keys()),
      ...Array.from(currentAllocations.keys()),
    ]);
    const results: AllocationResult[] = [];

    for (const protocol of protocols) {
      const currentBalance = currentAllocations.get(protocol) ?? 0;
      const targetBalance = targetBalances.get(protocol) ?? 0;
      const diff = round(targetBalance - currentBalance, 6);

      let action: 'deposit' | 'withdraw' | 'none' = 'none';
      let amount = 0;

      if (diff > 0.01) {
        action = 'deposit';
        amount = round(diff, 6);
      } else if (diff < -0.01) {
        action = 'withdraw';
        amount = round(Math.abs(diff), 6);
      }

      results.push({ protocol, currentBalance, targetBalance, action, amount });
    }

    return results;
  }

  /**
   * Calculate optimal allocation across protocols using wallet + deployed capital.
   */
  calculateOptimalAllocation(
    totalUsdc: number,
    currentAllocations: Map<string, number>,
    apyRanking: { protocol: string; apy: number }[],
  ): AllocationResult[] {
    const bufferAmount = round(totalUsdc * (this.config.lending.bufferPct / 100), 6);
    const deployable = round(Math.max(totalUsdc - bufferAmount, 0), 6);
    const results = this.calculateAllocationForDeployable(
      deployable,
      currentAllocations,
      apyRanking,
    );

    log.info(
      {
        totalUsdc,
        bufferAmount,
        deployable,
      },
      'Lending rebalance budget',
    );

    return results;
  }

  async planRebalanceToTargetTotal(
    targetDeployedUsdc: number,
  ): Promise<AllocationResult[]> {
    const [currentAllocations, apyRanking] = await Promise.all([
      this.getCurrentAllocations(),
      this.getApyRanking(),
    ]);

    return this.calculateAllocationForDeployable(
      round(Math.max(targetDeployedUsdc, 0), 6),
      currentAllocations,
      apyRanking,
    );
  }

  async executePlan(
    allocations: AllocationResult[],
    phases: Array<'withdraw' | 'deposit'> = ['withdraw', 'deposit'],
  ): Promise<{ txSigs: string[]; events: LedgerEvent[] }> {
    const txSigs: string[] = [];
    const events: LedgerEvent[] = [];

    const executeWithdrawals = phases.includes('withdraw');
    const executeDeposits = phases.includes('deposit');

    if (executeWithdrawals) {
      const withdrawals = allocations.filter((a) => a.action === 'withdraw');
      for (const alloc of withdrawals) {
        const protocol = this.protocols.get(alloc.protocol);
        if (!protocol) continue;

        try {
          log.info(
            { protocol: alloc.protocol, amount: alloc.amount },
            'Withdrawing from protocol',
          );
          const txSig = await protocol.withdraw(alloc.amount);
          txSigs.push(txSig);

          const feeSol = this.rpcUrl ? await getTxFeeInSol(this.rpcUrl, txSig) : 0;

          events.push({
            timestamp: new Date().toISOString(),
            eventType: EventType.WITHDRAW,
            amount: alloc.amount,
            asset: 'USDC',
            txHash: txSig,
            fee: feeSol,
            feeAsset: 'SOL',
            sourceProtocol: alloc.protocol,
            metadata: {
              action: 'rebalance_withdraw',
              previousBalance: alloc.currentBalance,
            },
          });

          log.info(
            { protocol: alloc.protocol, amount: alloc.amount, txSig },
            'Withdrawal complete',
          );
        } catch (err) {
          log.error(
            { protocol: alloc.protocol, amount: alloc.amount, error: err },
            'Withdrawal failed',
          );
          events.push({
            timestamp: new Date().toISOString(),
            eventType: EventType.ALERT,
            amount: alloc.amount,
            asset: 'USDC',
            sourceProtocol: alloc.protocol,
            metadata: {
              action: 'rebalance_withdraw_failed',
              error: String(err),
            },
          });
        }
      }
    }

    if (executeDeposits) {
      const deposits = allocations.filter((a) => a.action === 'deposit');
      for (const alloc of deposits) {
        const protocol = this.protocols.get(alloc.protocol);
        if (!protocol) continue;

        try {
          log.info(
            { protocol: alloc.protocol, amount: alloc.amount },
            'Depositing to protocol',
          );
          const txSig = await protocol.deposit(alloc.amount);
          txSigs.push(txSig);

          const feeSol = this.rpcUrl ? await getTxFeeInSol(this.rpcUrl, txSig) : 0;

          events.push({
            timestamp: new Date().toISOString(),
            eventType: EventType.DEPOSIT,
            amount: alloc.amount,
            asset: 'USDC',
            txHash: txSig,
            fee: feeSol,
            feeAsset: 'SOL',
            sourceProtocol: alloc.protocol,
            metadata: {
              action: 'rebalance_deposit',
              previousBalance: alloc.currentBalance,
            },
          });

          log.info(
            { protocol: alloc.protocol, amount: alloc.amount, txSig },
            'Deposit complete',
          );
        } catch (err) {
          log.error(
            { protocol: alloc.protocol, amount: alloc.amount, error: err },
            'Deposit failed',
          );
          events.push({
            timestamp: new Date().toISOString(),
            eventType: EventType.ALERT,
            amount: alloc.amount,
            asset: 'USDC',
            sourceProtocol: alloc.protocol,
            metadata: {
              action: 'rebalance_deposit_failed',
              error: String(err),
            },
          });
        }
      }
    }

    return { txSigs, events };
  }

  /**
   * Execute rebalance: withdraw from over-allocated protocols, then deposit
   * into the target protocol. Returns transaction signatures and ledger events.
   */
  async rebalance(walletUsdcBalance = 0): Promise<{ txSigs: string[]; events: LedgerEvent[] }> {
    const [currentAllocations, apyRanking] = await Promise.all([
      this.getCurrentAllocations(),
      this.getApyRanking(),
    ]);

    const totalDeployed = Array.from(currentAllocations.values()).reduce(
      (sum, b) => sum + b,
      0,
    );

    // Include wallet USDC so initial deployment and top-ups work
    const totalUsdc = totalDeployed + walletUsdcBalance;

    const allocations = this.calculateOptimalAllocation(
      totalUsdc,
      currentAllocations,
      apyRanking,
    );

    // Check if any rebalancing is needed
    const actionNeeded = allocations.some((a) => a.action !== 'none');
    if (!actionNeeded) {
      log.info('No rebalancing needed');
      return { txSigs: [], events: [] };
    }

    log.info({ allocations }, 'Starting rebalance');
    const { txSigs, events } = await this.executePlan(allocations);

    log.info(
      { txCount: txSigs.length, eventCount: events.length },
      'Rebalance complete',
    );

    return { txSigs, events };
  }
}
