import { createChildLogger } from '../utils/logger.js';
import { getConfig, configManager } from '../config.js';
import { Scheduler } from './scheduler.js';
import { evaluateState, type StateSignals } from './state-machine.js';
import { FrMonitor } from './fr-monitor.js';
import { BaseAllocator } from '../strategies/base-allocator.js';
import { DnExecutor, DnStep } from '../strategies/dn-executor.js';
import { RiskManager } from '../risk/risk-manager.js';
import { checkKillSwitch } from '../risk/guardrails.js';
import { recordEvent } from '../measurement/events.js';
import { recordSnapshot } from '../measurement/snapshots.js';
import { calculateDailyPnl, saveDailyPnl } from '../measurement/pnl.js';
import { getStateJson, setStateJson } from '../measurement/state-store.js';
import { getPrices } from '../connectors/prices.js';
import { sendAlert } from '../utils/notify.js';
import { getTxFeeInSol } from '../utils/tx-fee.js';
import { SolanaRpc } from '../connectors/solana/rpc.js';
import { BotState, EventType, ActionType, type PerpExchange, type PortfolioSnapshot, type Action, type FundingRateData } from '../types.js';
import type { BinanceRestClient } from '../connectors/binance/rest.js';
import type { BinanceWsClient } from '../connectors/binance/ws.js';
import type { KaminoLoopLending } from '../connectors/defi/kamino-loop.js';
import type { KaminoMultiplyLending } from '../connectors/defi/kamino-multiply.js';
import type { MarketScanner } from './market-scanner.js';

const log = createChildLogger('orchestrator');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface OrchestratorDeps {
  binanceRest: BinanceRestClient | null;
  binanceWs: BinanceWsClient | null;
  frMonitor: FrMonitor;
  baseAllocator: BaseAllocator;
  dnExecutor: DnExecutor;
  riskManager: RiskManager;
  solanaRpc: SolanaRpc;
  walletAddress: string;
  perpExchange?: PerpExchange;
  kaminoLoop?: KaminoLoopLending | null;
  kaminoMultiplyAdapters?: KaminoMultiplyLending[];
  marketScanner?: MarketScanner | null;
}

interface PersistedState {
  botState: BotState;
  startedAt: string;
  lastDnStep: DnStep;
}

export class Orchestrator {
  private scheduler: Scheduler;
  private deps: OrchestratorDeps;
  private botState: BotState = BotState.BASE_ONLY;
  private dnOperationInProgress = false;
  private startedAt: number = Date.now();
  private running = false;

  // Snapshot cache — shared across healthCheck, evaluateAndAct, executeAction
  private snapshotCache: { data: PortfolioSnapshot; fetchedAt: number } | null = null;
  private static readonly SNAPSHOT_CACHE_TTL_MS = 10_000;

  // WebSocket connection tracking
  private wsConnected = false;

  // Daily PnL timer
  private dailyPnlTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.scheduler = new Scheduler();
    this.restoreState();
    this.setupScheduledTasks();
    this.setupConfigReload();
  }

  private restoreState(): void {
    const persisted = getStateJson<PersistedState>('orchestrator');
    if (persisted) {
      this.botState = persisted.botState;
      log.info({ state: this.botState }, 'Restored state from DB');

      // If DN operation was in progress, check executor state
      if (persisted.lastDnStep !== DnStep.IDLE &&
          persisted.lastDnStep !== DnStep.ENTRY_COMPLETE &&
          persisted.lastDnStep !== DnStep.EXIT_COMPLETE) {
        this.dnOperationInProgress = true;
        log.warn({ step: persisted.lastDnStep }, 'DN operation was in progress before restart');
      }
    }
  }

  private persistState(): void {
    setStateJson('orchestrator', {
      botState: this.botState,
      startedAt: new Date(this.startedAt).toISOString(),
      lastDnStep: this.deps.dnExecutor.getState().currentStep,
    });
  }

  private setupScheduledTasks(): void {
    const config = getConfig();

    // FR monitoring — every hour (skipped when WebSocket is connected)
    this.scheduler.register('fr-fetch', 3_600_000, async () => {
      if (this.wsConnected) {
        log.debug('Skipping REST FR fetch — WebSocket is connected');
        return;
      }
      await this.fetchFundingRate();
    });

    // State evaluation — every tick
    this.scheduler.register('state-eval', config.general.tickIntervalMs, async () => {
      await this.evaluateAndAct();
    });

    // Portfolio snapshot — every 5 min
    this.scheduler.register('snapshot', config.general.snapshotIntervalMs, async () => {
      await this.takeSnapshot();
    });

    // Lending rebalance — every 6h
    this.scheduler.register('lending-rebalance', config.general.lendingRebalanceIntervalMs, async () => {
      await this.rebalanceLending();
    });

    // Daily PnL — scheduled via setTimeout at UTC 00:00
    this.scheduleDailyPnl();

    // Health check + kill switch — every 5 seconds
    this.scheduler.register('health-check', 5_000, async () => {
      await this.healthCheck();
    });

    // Kamino Loop health monitoring — every 5 minutes
    if (this.deps.kaminoLoop) {
      this.scheduler.register('kamino-loop-health', 300_000, async () => {
        await this.checkKaminoLoopHealth();
      });
    }

    // Multiply market scanner — periodic scan + switch evaluation
    if (this.deps.marketScanner) {
      const scanInterval = config.multiplyRebalance?.scanIntervalMs ?? 21_600_000;
      this.scheduler.register('multiply-market-scan', scanInterval, async () => {
        await this.scanAndSwitchMultiplyMarket();
      });
    }

    // Kamino Multiply health monitoring — every 5 minutes
    if (this.deps.kaminoMultiplyAdapters && this.deps.kaminoMultiplyAdapters.length > 0) {
      this.scheduler.register('kamino-multiply-health', 300_000, async () => {
        await this.checkKaminoMultiplyHealth();
      });

      // Reward claiming — every 24 hours
      this.scheduler.register('kamino-multiply-rewards', 86_400_000, async () => {
        await this.claimKaminoMultiplyRewards();
      });
    }
  }

  private setupConfigReload(): void {
    configManager.on('change', (newConfig, _oldConfig) => {
      log.info('Config reloaded, updating scheduler intervals');
      recordEvent({
        timestamp: new Date().toISOString(),
        eventType: EventType.STATE_CHANGE,
        amount: 0,
        asset: 'CONFIG',
        metadata: { action: 'config_reload' },
      });
    });
  }

  async start(): Promise<void> {
    this.running = true;
    this.startedAt = Date.now();
    log.info({ state: this.botState, dryRun: getConfig().general.dryRun }, 'Orchestrator starting');

    // Track WebSocket connection state (Binance only)
    if (this.deps.binanceWs) {
      this.deps.binanceWs.onConnectionStateChange((state) => {
        this.wsConnected = state === 'connected';
      });

      this.deps.binanceWs.onFundingRate((data) => {
        const frData: FundingRateData = {
          symbol: data.symbol,
          fundingRate: data.fundingRate,
          fundingTime: data.nextFundingTime,
          markPrice: data.markPrice,
        };
        this.deps.frMonitor.recordFundingRate(frData);
      });
      this.deps.binanceWs.connect();
    }

    // Initial FR fetch
    await this.fetchFundingRate();

    // Initial snapshot
    await this.takeSnapshot();

    // Start scheduler
    this.scheduler.start();

    await sendAlert('Vault Bot started', 'info');
    log.info('Orchestrator started');
  }

  async stop(): Promise<void> {
    log.info('Orchestrator stopping...');
    this.running = false;
    this.scheduler.stop();
    if (this.dailyPnlTimer) {
      clearTimeout(this.dailyPnlTimer);
      this.dailyPnlTimer = null;
    }
    this.deps.binanceWs?.disconnect();
    this.persistState();
    await sendAlert('Vault Bot stopped', 'info');
    log.info('Orchestrator stopped');
  }

  private async fetchFundingRate(): Promise<void> {
    try {
      const config = getConfig();

      if (!this.deps.binanceRest) {
        log.debug('Skipping FR fetch — no perp connector available');
        return;
      }

      const rates = await this.deps.binanceRest.getFundingRate(config.binance.symbol, 1);
      const rate = rates[0];
      if (rate) {
        this.deps.frMonitor.recordFundingRate({
          symbol: rate.symbol,
          fundingRate: parseFloat(rate.fundingRate),
          fundingTime: rate.fundingTime,
          markPrice: parseFloat(rate.markPrice),
        });
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to fetch funding rate');
    }
  }

  private async evaluateAndAct(): Promise<void> {
    try {
      const config = getConfig();
      const thresholds = config.thresholds;

      const snapshot = await this.getOrBuildSnapshot();

      const signals: StateSignals = {
        currentState: this.botState,
        avgFrAnnualized: this.deps.frMonitor.getAverageAnnualized(thresholds.frEntryConfirmationDays),
        latestFrAnnualized: this.deps.frMonitor.getLatestAnnualized(),
        daysAboveEntry: this.deps.frMonitor.getDaysAboveThreshold(thresholds.frEntryAnnualized),
        daysBelowExit: this.deps.frMonitor.getDaysBelowThreshold(thresholds.frExitAnnualized),
        riskApproved: true, // Will be overridden by risk manager
        dnOperationInProgress: this.dnOperationInProgress,
        totalNavUsdc: snapshot.totalNavUsdc,
      };

      const result = evaluateState(signals, config);

      if (result.nextState !== this.botState) {
        log.info({
          from: this.botState,
          to: result.nextState,
          reason: result.reason,
        }, 'State transition');

        recordEvent({
          timestamp: new Date().toISOString(),
          eventType: EventType.STATE_CHANGE,
          amount: 0,
          asset: 'STATE',
          metadata: {
            from: this.botState,
            to: result.nextState,
            reason: result.reason,
          },
        });

        await sendAlert(
          `State: ${this.botState} → ${result.nextState}\nReason: ${result.reason}`,
          result.actions.some(a => a.type === ActionType.EMERGENCY_EXIT) ? 'critical' : 'warning',
        );

        // Execute actions
        for (const action of result.actions) {
          await this.executeAction(action);
        }

        this.botState = result.nextState;
        this.persistState();
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'evaluateAndAct failed');
      await sendAlert(`State evaluation failed: ${(err as Error).message}`, 'warning');
    }
  }

  private async executeAction(action: Action): Promise<void> {
    const config = getConfig();

    // Pre-trade risk check
    const snapshot = await this.getOrBuildSnapshot();
    const riskCheck = this.deps.riskManager.preTradeCheck(action, snapshot);
    if (!riskCheck.approved) {
      log.warn({ action: action.type, reason: riskCheck.reason }, 'Action rejected by risk manager');
      await sendAlert(`Action ${action.type} blocked: ${riskCheck.reason}`, 'warning');
      return;
    }

    if (config.general.dryRun) {
      log.info({ action: action.type }, 'DRY RUN: Would execute action');
      return;
    }

    switch (action.type) {
      case ActionType.DN_ENTRY: {
        this.dnOperationInProgress = true;
        try {
          const usdcAmount = (action.params.usdcAmount as number) || 0;
          await this.deps.dnExecutor.startEntry(usdcAmount);
        } catch (err) {
          log.error({ error: (err as Error).message }, 'DN entry failed');
          await sendAlert(`DN entry failed: ${(err as Error).message}`, 'critical');
        } finally {
          this.dnOperationInProgress = false;
          this.persistState();
        }
        break;
      }
      case ActionType.DN_EXIT:
      case ActionType.EMERGENCY_EXIT: {
        this.dnOperationInProgress = true;
        try {
          await this.deps.dnExecutor.startExit();
        } catch (err) {
          log.error({ error: (err as Error).message }, 'DN exit failed');
          await sendAlert(`DN exit failed: ${(err as Error).message}`, 'critical');
        } finally {
          this.dnOperationInProgress = false;
          this.persistState();
        }
        break;
      }
      case ActionType.REBALANCE_LENDING: {
        await this.rebalanceLending();
        break;
      }
    }

    // Action completed — invalidate snapshot cache since portfolio changed
    this.snapshotCache = null;
  }

  private async rebalanceLending(): Promise<void> {
    try {
      // Fetch wallet USDC balance so initial deployment works
      let walletUsdc = 0;
      try {
        const rawBalance = await this.deps.solanaRpc.getTokenBalance(
          this.deps.walletAddress,
          USDC_MINT,
        );
        walletUsdc = rawBalance / 1e6; // Convert from base units (6 decimals)
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'Failed to fetch wallet USDC balance');
      }

      const result = await this.deps.baseAllocator.rebalance(walletUsdc);
      if (result.events.length > 0) {
        for (const event of result.events) {
          recordEvent(event);
        }
        log.info({ txCount: result.txSigs.length }, 'Lending rebalance completed');
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Lending rebalance failed');
    }
  }

  private async takeSnapshot(): Promise<void> {
    try {
      const snapshot = await this.buildSnapshot();
      this.snapshotCache = { data: snapshot, fetchedAt: Date.now() };
      recordSnapshot(snapshot);
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to take snapshot');
    }
  }

  private async getOrBuildSnapshot(): Promise<PortfolioSnapshot> {
    if (this.snapshotCache && Date.now() - this.snapshotCache.fetchedAt < Orchestrator.SNAPSHOT_CACHE_TTL_MS) {
      return this.snapshotCache.data;
    }
    const snapshot = await this.buildSnapshot();
    this.snapshotCache = { data: snapshot, fetchedAt: Date.now() };
    return snapshot;
  }

  private async buildSnapshot(): Promise<PortfolioSnapshot> {
    const config = getConfig();
    const prices = await getPrices();

    // Get lending balances
    const lendingAllocations = await this.deps.baseAllocator.getCurrentAllocations();
    let lendingTotal = 0;
    const lendingBreakdown: Record<string, number> = {};
    for (const [protocol, balance] of lendingAllocations) {
      lendingBreakdown[protocol] = balance;
      lendingTotal += balance;
    }

    // Get wallet USDC buffer balance
    let bufferUsdcBalance = 0;
    try {
      const rawBalance = await this.deps.solanaRpc.getTokenBalance(
        this.deps.walletAddress,
        USDC_MINT,
      );
      bufferUsdcBalance = rawBalance / 1e6;
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to get buffer USDC for snapshot');
    }

    // Get perp exchange balances (Binance or Drift)
    let binanceUsdcBalance = 0;
    let binancePerpUnrealizedPnl = 0;
    let binancePerpSize = 0;

    if (this.deps.binanceRest) {
      try {
        const balances = await this.deps.binanceRest.getBalance();
        const usdcBal = balances.find((b: any) => b.asset === 'USDC' || b.asset === 'USDT');
        binanceUsdcBalance = usdcBal ? parseFloat(usdcBal.balance) : 0;

        if (this.botState === BotState.BASE_DN) {
          const positions = await this.deps.binanceRest.getPosition(config.binance.symbol);
          const pos = positions.find((p: any) => parseFloat(p.positionAmt) !== 0);
          if (pos) {
            binancePerpUnrealizedPnl = parseFloat(pos.unrealizedProfit);
            binancePerpSize = Math.abs(parseFloat(pos.positionAmt));
          }
        }
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'Failed to get Binance data for snapshot');
      }
    }

    // dawnSOL (from DN executor state)
    const dnState = this.deps.dnExecutor.getState();
    const dawnsolBalance = dnState.dawnsolAmount;
    const dawnsolUsdcValue = dawnsolBalance * prices.dawnsol;

    const totalNavUsdc = lendingTotal + bufferUsdcBalance + binanceUsdcBalance + dawnsolUsdcValue + binancePerpUnrealizedPnl;

    return {
      timestamp: new Date().toISOString(),
      totalNavUsdc,
      lendingBalance: lendingTotal,
      lendingBreakdown,
      bufferUsdcBalance,
      dawnsolBalance,
      dawnsolUsdcValue,
      binanceUsdcBalance,
      binancePerpUnrealizedPnl,
      binancePerpSize,
      state: this.botState,
      solPrice: prices.sol,
      dawnsolPrice: prices.dawnsol,
    };
  }

  private async runDailyPnl(): Promise<void> {
    try {
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const dateStr = yesterday.toISOString().split('T')[0]!;

      const pnl = calculateDailyPnl(dateStr);
      saveDailyPnl(pnl);
      if (pnl) {
        const report = [
          `Daily PnL Report (${dateStr})`,
          `NAV: $${pnl.startingNav.toFixed(2)} → $${pnl.endingNav.toFixed(2)}`,
          `Return: ${(pnl.dailyReturn * 100).toFixed(4)}%`,
          `Lending: $${pnl.lendingInterest.toFixed(4)}`,
          `Funding: $${(pnl.fundingReceived - pnl.fundingPaid).toFixed(4)}`,
          `Fees: -$${pnl.totalFees.toFixed(4)}`,
        ].join('\n');
        await sendAlert(report, 'info');
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to calculate daily PnL');
    }
  }

  private scheduleDailyPnl(): void {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
    nextMidnight.setUTCHours(0, 0, 0, 0);
    const msUntilMidnight = nextMidnight.getTime() - now.getTime();

    this.dailyPnlTimer = setTimeout(async () => {
      if (!this.running) return;
      await this.runDailyPnl();
      this.scheduleDailyPnl();
    }, msUntilMidnight);

    log.info({ msUntilMidnight }, 'Daily PnL scheduled');
  }

  private async healthCheck(): Promise<void> {
    // Kill switch check
    if (checkKillSwitch()) {
      log.error('KILL SWITCH ACTIVATED');
      await sendAlert('KILL SWITCH ACTIVATED — stopping bot', 'critical');

      if (this.botState === BotState.BASE_DN) {
        await this.executeAction({
          type: ActionType.EMERGENCY_EXIT,
          params: { reason: 'kill_switch' },
          timestamp: Date.now(),
        });
      }

      await this.stop();
      process.exit(1);
    }

    // Continuous risk monitoring
    try {
      const snapshot = await this.getOrBuildSnapshot();
      const monitorResult = this.deps.riskManager.continuousMonitor(snapshot);

      for (const alert of monitorResult.alerts) {
        await sendAlert(alert.message, alert.level as 'warning' | 'critical');
      }

      for (const action of monitorResult.actions) {
        await this.executeAction(action);
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Health check error');
    }
  }

  /**
   * Monitor Kamino Loop health rate.
   * - Below alertHealthRate (1.10): send warning alert
   * - Below emergencyHealthRate (1.05): auto-deleverage
   */
  private async checkKaminoLoopHealth(): Promise<void> {
    const kaminoLoop = this.deps.kaminoLoop;
    if (!kaminoLoop) return;

    try {
      const health = await kaminoLoop.getHealthRate();
      if (health === Infinity) return; // no borrows, nothing to monitor

      const loopConfig = kaminoLoop.getLoopConfig();

      log.debug({ healthRate: health }, 'Kamino Loop health check');

      if (health < loopConfig.emergencyHealthRate) {
        // CRITICAL: auto-deleverage
        log.error({ health, threshold: loopConfig.emergencyHealthRate }, 'Kamino Loop health CRITICAL — emergency deleverage');
        await sendAlert(
          `Kamino Loop health CRITICAL: ${health.toFixed(3)} (threshold: ${loopConfig.emergencyHealthRate})\nTriggering emergency deleverage`,
          'critical',
        );

        const config = getConfig();
        if (!config.general.dryRun) {
          const txSigs = await kaminoLoop.emergencyDeleverage();
          for (const txSig of txSigs) {
            recordEvent({
              timestamp: new Date().toISOString(),
              eventType: EventType.ALERT,
              amount: 0,
              asset: 'USDC',
              txHash: txSig,
              sourceProtocol: 'kamino-loop',
              metadata: {
                action: 'emergency_deleverage',
                healthRate: health,
              },
            });
          }
          await sendAlert(
            `Emergency deleverage complete — ${txSigs.length} transactions`,
            'critical',
          );
        } else {
          log.info('DRY RUN: Would trigger emergency deleverage');
        }
      } else if (health < loopConfig.alertHealthRate) {
        // WARNING: approaching danger zone
        log.warn({ health, threshold: loopConfig.alertHealthRate }, 'Kamino Loop health WARNING');
        await sendAlert(
          `Kamino Loop health WARNING: ${health.toFixed(3)} (alert threshold: ${loopConfig.alertHealthRate})`,
          'warning',
        );
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Kamino Loop health check failed');
    }
  }

  /**
   * Monitor all Kamino Multiply positions' health rates.
   */
  private async checkKaminoMultiplyHealth(): Promise<void> {
    const adapters = this.deps.kaminoMultiplyAdapters;
    if (!adapters || adapters.length === 0) return;

    for (const adapter of adapters) {
      try {
        const health = await adapter.getHealthRate();
        if (health === Infinity) continue;

        const cfg = adapter.getMultiplyConfig();
        const label = cfg.label;

        log.debug({ label, healthRate: health }, 'Kamino Multiply health check');

        if (health < cfg.emergencyHealthRate) {
          log.error({ label, health, threshold: cfg.emergencyHealthRate }, 'Kamino Multiply health CRITICAL');
          await sendAlert(
            `Kamino Multiply [${label}] health CRITICAL: ${health.toFixed(3)}\nTriggering emergency deleverage`,
            'critical',
          );

          const config = getConfig();
          if (!config.general.dryRun) {
            const txSigs = await adapter.emergencyDeleverage();
            for (const txSig of txSigs) {
              recordEvent({
                timestamp: new Date().toISOString(),
                eventType: EventType.ALERT,
                amount: 0,
                asset: 'USD',
                txHash: txSig,
                sourceProtocol: adapter.name,
                metadata: { action: 'emergency_deleverage', healthRate: health },
              });
            }
            await sendAlert(`[${label}] Emergency deleverage complete`, 'critical');
          } else {
            log.info({ label }, 'DRY RUN: Would trigger emergency deleverage');
          }
        } else if (health < cfg.alertHealthRate) {
          log.warn({ label, health, threshold: cfg.alertHealthRate }, 'Kamino Multiply health WARNING');
          await sendAlert(
            `Kamino Multiply [${label}] health WARNING: ${health.toFixed(3)} (alert: ${cfg.alertHealthRate})`,
            'warning',
          );
        }
      } catch (err) {
        log.error({ error: (err as Error).message, adapter: adapter.name }, 'Kamino Multiply health check failed');
      }
    }
  }

  /**
   * Claim pending rewards for all Kamino Multiply positions.
   */
  private async claimKaminoMultiplyRewards(): Promise<void> {
    const adapters = this.deps.kaminoMultiplyAdapters;
    if (!adapters || adapters.length === 0) return;

    const config = getConfig();
    if (config.general.dryRun) {
      log.info('DRY RUN: Would claim Kamino Multiply rewards');
      return;
    }

    for (const adapter of adapters) {
      try {
        const results = await adapter.claimRewards();
        if (results.length > 0) {
          log.info({ adapter: adapter.name, claims: results.length }, 'Multiply rewards claimed');
          for (const r of results) {
            recordEvent({
              timestamp: new Date().toISOString(),
              eventType: EventType.LENDING_INTEREST,
              amount: r.amount,
              asset: r.mint,
              txHash: r.txSig,
              sourceProtocol: adapter.name,
              metadata: { action: 'reward_claim' },
            });
          }
        }
      } catch (err) {
        log.error({ error: (err as Error).message, adapter: adapter.name }, 'Multiply reward claim failed');
      }
    }
  }

  /**
   * Scan all Multiply candidate markets and switch if a better market is found.
   */
  private async scanAndSwitchMultiplyMarket(): Promise<void> {
    const scanner = this.deps.marketScanner;
    if (!scanner) return;

    try {
      // Step 1: Scan all candidates
      await scanner.scanAll();

      // Step 2: Find current active multiply adapter
      const adapters = this.deps.kaminoMultiplyAdapters;
      if (!adapters || adapters.length === 0) {
        log.debug('No active Multiply adapters, skipping switch evaluation');
        return;
      }

      // We manage one primary multiply position for rebalancing
      const currentAdapter = adapters[0]!;
      const currentLabel = currentAdapter.getMultiplyConfig().label;

      // Get current balance to filter candidates by capacity
      const currentBalance = await currentAdapter.getBalance();

      // Step 3: Get recommendation (pass deployable amount for capacity filtering)
      const recommendation = scanner.getRecommendation(currentLabel, currentBalance);
      if (!recommendation) {
        log.debug({ currentLabel }, 'No market switch recommended');
        return;
      }

      log.info(
        {
          from: recommendation.from,
          to: recommendation.to,
          diffBps: recommendation.diffBps,
          fromApy: `${(recommendation.fromApy * 100).toFixed(2)}%`,
          toApy: `${(recommendation.toApy * 100).toFixed(2)}%`,
        },
        'Multiply market switch triggered',
      );

      await sendAlert(
        `Multiply market switch: ${recommendation.from} → ${recommendation.to}\n` +
        `APY: ${(recommendation.fromApy * 100).toFixed(2)}% → ${(recommendation.toApy * 100).toFixed(2)}% (+${recommendation.diffBps}bps)`,
        'warning',
      );

      const config = getConfig();
      if (config.general.dryRun) {
        log.info('DRY RUN: Would switch multiply market');
        return;
      }

      // Step 4: Withdraw from current position (reuse balance from above)
      if (currentBalance < 0.01) {
        log.info('Current position balance is negligible, skipping withdraw');
      } else {
        log.info({ balance: currentBalance, from: currentLabel }, 'Withdrawing from current market');
        const withdrawSig = await currentAdapter.withdraw(currentBalance);
        const rpcUrl = process.env.HELIUS_RPC_URL ?? '';
        const withdrawFee = rpcUrl ? await getTxFeeInSol(rpcUrl, withdrawSig) : 0;

        recordEvent({
          timestamp: new Date().toISOString(),
          eventType: EventType.REBALANCE,
          amount: currentBalance,
          asset: 'USD',
          txHash: withdrawSig,
          fee: withdrawFee,
          feeAsset: 'SOL',
          sourceProtocol: currentAdapter.name,
          metadata: {
            action: 'multiply_market_switch_withdraw',
            from: currentLabel,
            to: recommendation.to,
          },
        });
      }

      // Step 5: Create new adapter and deposit
      const newAdapter = scanner.createFullAdapter(recommendation.candidate);
      const depositAmount = currentBalance > 0.01 ? currentBalance : 0;

      if (depositAmount > 0.01) {
        log.info({ amount: depositAmount, to: recommendation.to }, 'Depositing to new market');
        const depositSig = await newAdapter.deposit(depositAmount);
        const depositFee = rpcUrl ? await getTxFeeInSol(rpcUrl, depositSig) : 0;

        recordEvent({
          timestamp: new Date().toISOString(),
          eventType: EventType.REBALANCE,
          amount: depositAmount,
          asset: 'USD',
          txHash: depositSig,
          fee: depositFee,
          feeAsset: 'SOL',
          sourceProtocol: newAdapter.name,
          metadata: {
            action: 'multiply_market_switch_deposit',
            from: currentLabel,
            to: recommendation.to,
          },
        });
      }

      // Step 6: Hot-swap adapter references
      const oldName = currentAdapter.name;
      adapters[0] = newAdapter;

      // Update base allocator
      this.deps.baseAllocator.replaceProtocol(oldName, newAdapter);

      // Record switch for holding period tracking
      scanner.recordSwitch();

      const newHealth = depositAmount > 0.01 ? await newAdapter.getHealthRate() : Infinity;

      log.info(
        { from: currentLabel, to: recommendation.to, depositAmount, newHealth },
        'Multiply market switch complete',
      );

      await sendAlert(
        `Market switch complete: ${currentLabel} → ${recommendation.to}\n` +
        `Deployed: $${depositAmount.toFixed(2)} | Health: ${newHealth === Infinity ? 'N/A' : newHealth.toFixed(3)}`,
        'info',
      );
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Multiply market scan/switch failed');
      await sendAlert(`Multiply market scan failed: ${(err as Error).message}`, 'warning');
    }
  }

  getBotState(): BotState {
    return this.botState;
  }

  isRunning(): boolean {
    return this.running;
  }

  getUptime(): number {
    return Date.now() - this.startedAt;
  }
}
