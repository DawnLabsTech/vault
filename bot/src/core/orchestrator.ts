import { createChildLogger } from '../utils/logger.js';
import { getConfig, configManager } from '../config.js';
import { Scheduler } from './scheduler.js';
import { evaluateState, type StateSignals } from './state-machine.js';
import { FrMonitor } from './fr-monitor.js';
import { BaseAllocator } from '../strategies/base-allocator.js';
import { CapitalAllocator } from '../strategies/capital-allocator.js';
import { determineMultiplyRiskAction } from './multiply-risk-policy.js';
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
import { BotState, EventType, ActionType, type PerpExchange, type PortfolioSnapshot, type Action, type FundingRateData, type RiskAssessment } from '../types.js';
import type { BinanceRestClient } from '../connectors/binance/rest.js';
import type { BinanceWsClient } from '../connectors/binance/ws.js';
import type { KaminoLoopLending } from '../connectors/defi/kamino-loop.js';
import type { KaminoMultiplyLending } from '../connectors/defi/kamino-multiply.js';
import type { MarketScanner } from './market-scanner.js';
import { ProtocolCircuitBreaker } from '../risk/protocol-circuit-breaker.js';
import type { OracleMonitor, OracleAnomalyEvent } from '../risk/oracle-monitor.js';
import { BorrowRateMonitor } from './borrow-rate-monitor.js';
import { LiquidityStressMonitor } from './liquidity-stress-monitor.js';
import type { Advisor } from '../advisor/advisor.js';
import type { AnomalyMonitor } from '../risk/anomaly-monitor.js';

const log = createChildLogger('orchestrator');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface OrchestratorDeps {
  binanceRest: BinanceRestClient | null;
  binanceWs: BinanceWsClient | null;
  frMonitor: FrMonitor;
  baseAllocator: BaseAllocator;
  capitalAllocator?: CapitalAllocator | null;
  dnExecutor: DnExecutor;
  riskManager: RiskManager;
  solanaRpc: SolanaRpc;
  walletAddress: string;
  perpExchange?: PerpExchange;
  kaminoLoop?: KaminoLoopLending | null;
  kaminoMultiplyAdapters?: KaminoMultiplyLending[];
  marketScanner?: MarketScanner | null;
  circuitBreaker?: ProtocolCircuitBreaker | null;
  oracleMonitor?: OracleMonitor | null;
  borrowRateMonitor?: BorrowRateMonitor | null;
  liquidityStressMonitor?: LiquidityStressMonitor | null;
  advisor?: Advisor | null;
  anomalyMonitor?: AnomalyMonitor | null;
}

interface PersistedState {
  botState: BotState;
  startedAt: string;
  lastDnStep: DnStep;
}

interface ActionExecutionResult {
  success: boolean;
  reason?: string;
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

  // AI Advisor event trigger tracking
  private lastAdvisorSolPrice: number = 0;
  private lastAdvisorRiskScore: number = 0;
  private lastAdvisorFrAnnualized: number = 0;
  private lastAdvisorRunAt: number = 0;
  private static readonly ADVISOR_COOLDOWN_MS = 1_800_000; // 30 min between event-triggered runs
  private static readonly SNAPSHOT_CACHE_TTL_MS = 30_000;

  // WebSocket connection tracking
  private wsConnected = false;

  // Daily PnL timer
  private dailyPnlTimer: ReturnType<typeof setTimeout> | null = null;

  // Suppress repeated utilization warnings for the same protocol
  private lastKaminoLoopUtilizationWarnAt = 0;
  private static readonly UTILIZATION_WARN_COOLDOWN_MS = 1_800_000; // 30 min

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

    // Base capital rebalance — every 6h (Multiply first, lending fallback)
    this.scheduler.register('lending-rebalance', config.general.lendingRebalanceIntervalMs, async () => {
      await this.rebalanceLending();
    });

    // Daily PnL — scheduled via setTimeout at UTC 00:00
    this.scheduleDailyPnl();

    // Health check + kill switch — every 10 seconds (aligned with snapshotCache TTL)
    this.scheduler.register('health-check', 10_000, async () => {
      await this.healthCheck();
    });

    // Protocol circuit breaker — every 60 seconds
    if (this.deps.circuitBreaker) {
      const cbInterval = config.circuitBreaker?.checkIntervalMs ?? 60_000;
      this.scheduler.register('circuit-breaker', cbInterval, async () => {
        await this.runCircuitBreaker();
      });
    }

    // Oracle anomaly monitor — every 5 minutes (aligned with multiply-health)
    if (this.deps.oracleMonitor) {
      const omInterval = config.oracleMonitor?.checkIntervalMs ?? 300_000;
      this.scheduler.register('oracle-monitor', omInterval, async () => {
        await this.runOracleMonitor();
      });
    }

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

      // Liquidity stress test — every 5 minutes (piggybacked on multiply health cycle)
      if (this.deps.liquidityStressMonitor) {
        this.scheduler.register('liquidity-stress-test', 300_000, async () => {
          await this.runLiquidityStressTests();
        });
      }
    }

    // AI Advisor — periodic evaluation (default 6h)
    if (this.deps.advisor) {
      const advisorInterval = 21_600_000; // 6h
      this.scheduler.register('ai-advisor', advisorInterval, async () => {
        await this.runAdvisor();
      });
    }

    // Anomaly polling fallback — every 1h. The webhook is the primary trigger;
    // this guards against webhook downtime or misconfiguration.
    if (this.deps.anomalyMonitor) {
      this.scheduler.register('anomaly-poll', 3_600_000, async () => {
        await this.deps.anomalyMonitor!.runChecks();
      });
    }

    // Status digest — every 12 hours
    this.scheduler.register('status-digest', 43_200_000, async () => {
      await this.sendStatusDigest();
    });
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

    // Prune old borrow rate records on startup
    if (this.deps.borrowRateMonitor) {
      const retentionDays = getConfig().borrowRateSpike?.sampleRetentionDays ?? 7;
      this.deps.borrowRateMonitor.prune(retentionDays);
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
        let actionFailureReason: string | undefined;
        for (const action of result.actions) {
          const execution = await this.executeAction(action);
          if (!execution.success) {
            actionFailureReason = execution.reason ?? `Action ${action.type} failed`;
            break;
          }
        }

        if (actionFailureReason) {
          log.warn(
            {
              from: this.botState,
              attemptedTo: result.nextState,
              reason: result.reason,
              actionFailureReason,
            },
            'State transition skipped because action execution did not succeed',
          );
          return;
        }

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

        this.botState = result.nextState;
        this.persistState();
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'evaluateAndAct failed');
      await sendAlert(`State evaluation failed: ${(err as Error).message}`, 'warning');
    }
  }

  private async executeAction(action: Action): Promise<ActionExecutionResult> {
    const config = getConfig();

    // Pre-trade risk check
    const snapshot = await this.getOrBuildSnapshot();
    const riskCheck = this.deps.riskManager.preTradeCheck(action, snapshot);
    if (!riskCheck.approved) {
      log.warn({ action: action.type, reason: riskCheck.reason }, 'Action rejected by risk manager');
      await sendAlert(`Action ${action.type} blocked: ${riskCheck.reason}`, 'warning');
      return { success: false, reason: riskCheck.reason };
    }

    if (config.general.dryRun) {
      log.info({ action: action.type }, 'DRY RUN: Would execute action');
      return { success: true, reason: 'dry_run' };
    }

    switch (action.type) {
      case ActionType.DN_ENTRY: {
        this.dnOperationInProgress = true;
        try {
          const usdcAmount = (action.params.usdcAmount as number) || 0;
          await this.deps.dnExecutor.startEntry(usdcAmount);
        } catch (err) {
          const reason = (err as Error).message;
          log.error({ error: reason }, 'DN entry failed');
          await sendAlert(`DN entry failed: ${reason}`, 'critical');
          return { success: false, reason };
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
          const reason = (err as Error).message;
          log.error({ error: reason }, 'DN exit failed');
          await sendAlert(`DN exit failed: ${reason}`, 'critical');
          return { success: false, reason };
        } finally {
          this.dnOperationInProgress = false;
          this.persistState();
        }
        break;
      }
      case ActionType.REBALANCE_LENDING: {
        try {
          await this.rebalanceLending();
        } catch (err) {
          const reason = (err as Error).message;
          log.error({ error: reason }, 'Lending rebalance action failed');
          return { success: false, reason };
        }
        break;
      }
    }

    // Action completed — invalidate snapshot cache since portfolio changed
    this.snapshotCache = null;
    return { success: true };
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

      const result = this.deps.capitalAllocator
        ? await this.deps.capitalAllocator.rebalance(walletUsdc)
        : await this.deps.baseAllocator.rebalance(walletUsdc);
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

      // Check advisor event triggers (price change, FR change)
      await this.checkAdvisorEventTriggers(snapshot);
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

    // Get lending balances (pure lending only — no multiply)
    const lendingAllocations = await this.deps.baseAllocator.getCurrentAllocations();
    let lendingTotal = 0;
    const lendingBreakdown: Record<string, number> = {};
    for (const [protocol, balance] of lendingAllocations) {
      lendingBreakdown[protocol] = balance;
      lendingTotal += balance;
    }

    // Get multiply balances (separate from lending)
    let multiplyTotal = 0;
    const multiplyBreakdown: Record<string, number> = {};
    if (this.deps.kaminoMultiplyAdapters) {
      const results = await Promise.allSettled(
        this.deps.kaminoMultiplyAdapters.map(async (adapter) => {
          const balance = await adapter.getBalance();
          return { label: adapter.getMultiplyConfig().label, balance };
        }),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          multiplyBreakdown[result.value.label] = result.value.balance;
          multiplyTotal += result.value.balance;
        }
      }
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

    // Get perp exchange balances (Binance)
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

    // Wallet collateral tokens (e.g. ONyc stranded from partial Multiply operations)
    let walletCollateralUsdcValue = 0;
    if (this.deps.kaminoMultiplyAdapters) {
      const collResults = await Promise.allSettled(
        this.deps.kaminoMultiplyAdapters.map(a => a.getWalletCollateralUsdValue()),
      );
      for (const r of collResults) {
        if (r.status === 'fulfilled') walletCollateralUsdcValue += r.value;
      }
    }

    // dawnSOL (from DN executor state)
    const dnState = this.deps.dnExecutor.getState();
    const dawnsolBalance = dnState.dawnsolAmount;
    const dawnsolUsdcValue = dawnsolBalance * prices.dawnsol;

    const totalNavUsdc = lendingTotal + multiplyTotal + bufferUsdcBalance + walletCollateralUsdcValue + binanceUsdcBalance + dawnsolUsdcValue + binancePerpUnrealizedPnl;

    return {
      timestamp: new Date().toISOString(),
      totalNavUsdc,
      lendingBalance: lendingTotal,
      lendingBreakdown,
      multiplyBalance: multiplyTotal,
      multiplyBreakdown,
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

      // Reserve utilization check — high USDC utilization means withdrawals may queue.
      // Early indicator of bank-run / exploit-driven exit pressure, even before TVL drops register.
      const utilization = await kaminoLoop.getSupplyUtilization();
      if (utilization !== null && utilization >= loopConfig.warnUtilizationRatio) {
        const now = Date.now();
        if (now - this.lastKaminoLoopUtilizationWarnAt > Orchestrator.UTILIZATION_WARN_COOLDOWN_MS) {
          log.warn(
            { utilization, threshold: loopConfig.warnUtilizationRatio },
            'Kamino Loop USDC utilization high',
          );
          await sendAlert(
            `Kamino Loop USDC utilization ${(utilization * 100).toFixed(1)}% ` +
              `(threshold ${(loopConfig.warnUtilizationRatio * 100).toFixed(0)}%) — withdrawals may be queued`,
            'warning',
          );
          this.lastKaminoLoopUtilizationWarnAt = now;
        }
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Kamino Loop health check failed');
    }
  }

  /**
   * Monitor all Kamino Multiply positions' health and risk levels.
   */
  private async checkKaminoMultiplyHealth(): Promise<void> {
    const adapters = this.deps.kaminoMultiplyAdapters;
    if (!adapters || adapters.length === 0) return;

    const scanner = this.deps.marketScanner;
    const rejectRiskScore = scanner?.getRejectThreshold() ?? 75;
    const emergencyRiskScore = scanner?.getEmergencyThreshold() ?? 90;
    const activeLabels = adapters.map((adapter) => adapter.getMultiplyConfig().label);

    let refreshedRiskAssessments = new Map<string, RiskAssessment>();
    if (scanner) {
      try {
        refreshedRiskAssessments = await scanner.refreshRiskAssessments(activeLabels);
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'Failed to refresh Multiply risk assessments');
      }
    }

    for (const adapter of adapters) {
      try {
        const cfg = adapter.getMultiplyConfig();
        const label = cfg.label;
        const config = getConfig();
        const [health, currentBalance] = await Promise.all([
          adapter.getHealthRate(),
          adapter.getBalance(),
        ]);
        const riskAssessment =
          refreshedRiskAssessments.get(label) ??
          scanner?.getLatestRiskAssessment(label) ??
          null;

        if (health === Infinity && currentBalance < 0.01) continue;

        log.debug(
          {
            label,
            healthRate: health,
            balance: currentBalance,
            riskScore: riskAssessment?.compositeScore ?? null,
          },
          'Kamino Multiply health/risk check',
        );

        // Check advisor event trigger for risk score spike
        if (riskAssessment && this.snapshotCache) {
          await this.checkAdvisorEventTriggers(this.snapshotCache.data, riskAssessment.compositeScore);
        }

        // Record borrow rate and detect spikes
        let borrowRateSpike: { level: 'warning' | 'critical' } | undefined;
        const brMonitor = this.deps.borrowRateMonitor;
        if (brMonitor) {
          try {
            const apyBreakdown = await adapter.getApyBreakdown();
            brMonitor.recordRate({
              label,
              baseBorrowApy: apyBreakdown.baseBorrowApy,
              baseSupplyApy: apyBreakdown.baseSupplyApy,
              effectiveApy: apyBreakdown.effectiveApy,
              nativeYield: apyBreakdown.nativeYield,
              leverage: apyBreakdown.leverage,
            });

            const spikeConfig = config.borrowRateSpike;
            if (spikeConfig) {
              const spike = brMonitor.detectSpike(label, spikeConfig);
              if (spike) {
                borrowRateSpike = { level: spike.level };
                await sendAlert(spike.message, spike.level);
              }
            }
          } catch (err) {
            log.warn({ error: (err as Error).message, label }, 'Failed to record/check borrow rate');
          }
        }

        const riskAction = determineMultiplyRiskAction({
          currentBalance,
          healthRate: health,
          alertHealthRate: cfg.alertHealthRate,
          emergencyHealthRate: cfg.emergencyHealthRate,
          riskAssessment,
          rejectRiskScore,
          emergencyRiskScore,
          borrowRateSpike,
        });

        // Tier 1: Emergency — full exit when health or risk is critical
        if (riskAction.type === 'emergency') {
          log.error(
            {
              label,
              health,
              healthThreshold: cfg.emergencyHealthRate,
              riskScore: riskAssessment?.compositeScore ?? null,
              riskThreshold: emergencyRiskScore,
            },
            'Kamino Multiply emergency deleverage triggered',
          );

          const message =
            riskAction.reason === 'borrow_rate_spike_emergency'
              ? `Kamino Multiply [${label}] BORROW RATE SPIKE: negative spread detected\nTriggering full exit`
              : riskAction.reason === 'health_and_risk_emergency'
                ? `Kamino Multiply [${label}] emergency: health ${health.toFixed(3)} < ${cfg.emergencyHealthRate}, risk ${(riskAssessment?.compositeScore ?? 0).toFixed(1)} >= ${emergencyRiskScore}\nTriggering full exit`
                : riskAction.reason === 'risk_emergency'
                  ? `Kamino Multiply [${label}] risk EMERGENCY: score ${(riskAssessment?.compositeScore ?? 0).toFixed(1)} >= ${emergencyRiskScore}\nTriggering full exit`
                  : `Kamino Multiply [${label}] health CRITICAL: ${health.toFixed(3)} < ${cfg.emergencyHealthRate}\nTriggering emergency deleverage`;

          await sendAlert(message, 'critical');

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
                metadata: {
                  action: riskAction.reason === 'risk_emergency' || riskAction.reason === 'health_and_risk_emergency'
                    ? 'risk_emergency_exit'
                    : 'emergency_deleverage',
                  healthRate: health,
                  riskScore: riskAssessment?.compositeScore ?? null,
                  trigger: riskAction.reason,
                },
              });
            }
            await sendAlert(`[${label}] Emergency deleverage complete`, 'critical');
          } else {
            log.info({ label, reason: riskAction.reason }, 'DRY RUN: Would trigger emergency deleverage');
          }

        // Tier 2: Soft deleverage — reduce size when health or risk crosses warning thresholds
        } else if (riskAction.type === 'reduce') {
          log.warn(
            {
              label,
              health,
              balance: currentBalance,
              reduceAmount: riskAction.amount,
              targetBalance: riskAction.targetBalance,
              riskScore: riskAssessment?.compositeScore ?? null,
              maxPositionCap: riskAssessment?.maxPositionCap ?? null,
            },
            'Kamino Multiply soft deleverage triggered',
          );

          if (!config.general.dryRun) {
            if (riskAction.amount > 1) {
              const message =
                riskAction.reason === 'health_and_risk_soft'
                  ? `Kamino Multiply [${label}] soft deleverage: health ${health.toFixed(3)} < ${cfg.alertHealthRate}, risk ${(riskAssessment?.compositeScore ?? 0).toFixed(1)} >= ${rejectRiskScore}\nReducing by $${riskAction.amount.toFixed(2)} to target $${riskAction.targetBalance.toFixed(2)}`
                  : riskAction.reason === 'risk_soft'
                    ? `Kamino Multiply [${label}] risk reduction: score ${(riskAssessment?.compositeScore ?? 0).toFixed(1)} >= ${rejectRiskScore}\nReducing by $${riskAction.amount.toFixed(2)} to cap $${(riskAssessment?.maxPositionCap ?? riskAction.targetBalance).toFixed(2)}`
                    : `Kamino Multiply [${label}] soft deleverage: health ${health.toFixed(3)} < ${cfg.alertHealthRate}\nReducing position by $${riskAction.amount.toFixed(2)}`;
              await sendAlert(
                message,
                'warning',
              );

              const txSig = await adapter.withdraw(riskAction.amount);
              recordEvent({
                timestamp: new Date().toISOString(),
                eventType: EventType.ALERT,
                amount: riskAction.amount,
                asset: 'USD',
                txHash: txSig,
                sourceProtocol: adapter.name,
                metadata: {
                  action: riskAction.reason === 'risk_soft' || riskAction.reason === 'health_and_risk_soft'
                    ? 'risk_soft_deleverage'
                    : 'soft_deleverage',
                  healthRate: health,
                  riskScore: riskAssessment?.compositeScore ?? null,
                  maxPositionCap: riskAssessment?.maxPositionCap ?? null,
                  reducePct: currentBalance > 0
                    ? Number(((riskAction.amount / currentBalance) * 100).toFixed(2))
                    : 0,
                  trigger: riskAction.reason,
                },
              });

              log.info({ label, reduceAmount: riskAction.amount, txSig }, 'Soft deleverage complete');
            }
          } else {
            log.info(
              { label, reason: riskAction.reason, amount: riskAction.amount },
              'DRY RUN: Would trigger soft deleverage',
            );
          }

        // Tier 3: Elevated monitoring — increase poll frequency
        } else if (health < 1.20) {
          log.info({ label, health }, 'Health rate below 1.20 — elevated monitoring');
          // Reduce multiply health check interval to 60s when health is low
          const task = this.scheduler.getStatus()['kamino-multiply-health'];
          if (task && task.intervalMs > 60_000) {
            this.scheduler.register('kamino-multiply-health', 60_000, async () => {
              await this.checkKaminoMultiplyHealth();
            });
            log.info({ label }, 'Multiply health check interval reduced to 60s');
          }
        } else {
          // Health is good — restore normal interval if it was reduced
          const task = this.scheduler.getStatus()['kamino-multiply-health'];
          if (task && task.intervalMs < 300_000) {
            this.scheduler.register('kamino-multiply-health', 300_000, async () => {
              await this.checkKaminoMultiplyHealth();
            });
            log.debug('Multiply health check interval restored to 5min');
          }
        }
      } catch (err) {
        log.error({ error: (err as Error).message, adapter: adapter.name }, 'Kamino Multiply health check failed');
      }
    }
  }

  /**
   * Run liquidity stress tests for all active Multiply positions.
   * Fetches exit quotes at 25%, 50%, 100% of position size and alerts on high slippage.
   */
  private async runLiquidityStressTests(): Promise<void> {
    const adapters = this.deps.kaminoMultiplyAdapters;
    const monitor = this.deps.liquidityStressMonitor;
    if (!adapters || adapters.length === 0 || !monitor) return;

    for (const adapter of adapters) {
      try {
        const cfg = adapter.getMultiplyConfig();
        const balance = await adapter.getBalance();

        if (balance < 1) continue;

        await monitor.runStressTest({
          label: cfg.label,
          collToken: cfg.collToken,
          debtToken: cfg.debtToken,
          collDecimals: cfg.collDecimals ?? 6,
          positionUsd: balance,
        });
      } catch (err) {
        log.warn(
          { error: (err as Error).message, adapter: adapter.name },
          'Liquidity stress test failed',
        );
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
          expectedGainUsd: recommendation.expectedGainUsd?.toFixed(2),
          estimatedSwitchCostUsd: recommendation.estimatedSwitchCostUsd?.toFixed(2),
          netExpectedGainUsd: recommendation.netExpectedGainUsd?.toFixed(2),
        },
        'Multiply market switch triggered',
      );

      const economicsSummary =
        recommendation.expectedGainUsd !== undefined &&
        recommendation.estimatedSwitchCostUsd !== undefined &&
        recommendation.netExpectedGainUsd !== undefined
          ? `\nExpected gain (${recommendation.paybackWindowDays}d): $${recommendation.expectedGainUsd.toFixed(2)} | Cost: $${recommendation.estimatedSwitchCostUsd.toFixed(2)} | Net: $${recommendation.netExpectedGainUsd.toFixed(2)}`
          : '';

      await sendAlert(
        `Multiply market switch: ${recommendation.from} → ${recommendation.to}\n` +
        `APY: ${(recommendation.fromApy * 100).toFixed(2)}% → ${(recommendation.toApy * 100).toFixed(2)}% (+${recommendation.diffBps}bps)` +
        economicsSummary,
        'warning',
      );

      const config = getConfig();
      if (config.general.dryRun) {
        log.info('DRY RUN: Would switch multiply market');
        return;
      }

      // Step 4: Withdraw from current position (reuse balance from above)
      const rpcUrl = process.env.HELIUS_RPC_URL ?? '';
      if (currentBalance < 0.01) {
        log.info('Current position balance is negligible, skipping withdraw');
      } else {
        log.info({ balance: currentBalance, from: currentLabel }, 'Withdrawing from current market');
        const withdrawSig = await currentAdapter.withdraw(currentBalance);
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

      // Step 6: Hot-swap active multiply adapter reference
      adapters[0] = newAdapter;

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

  /**
   * Run protocol circuit breaker checks.
   * Events are logged and, if critical, trigger emergency withdrawal.
   */
  private async runCircuitBreaker(): Promise<void> {
    const cb = this.deps.circuitBreaker;
    if (!cb) return;

    try {
      const events = await cb.check();
      for (const event of events) {
        recordEvent({
          timestamp: new Date().toISOString(),
          eventType: EventType.ALERT,
          amount: 0,
          asset: 'USDC',
          sourceProtocol: event.protocol,
          metadata: {
            action: 'circuit_breaker',
            reason: event.reason,
            severity: event.severity,
            ...event.data,
          },
        });
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Circuit breaker check failed');
    }
  }

  /**
   * Run oracle anomaly checks. The monitor itself sends Telegram alerts;
   * this method records events for measurement and dispatches actions for
   * sustained critical events:
   *   - `stable-depeg` (sustained): trip all protocols and emergency-deleverage
   *     every Multiply position (NAV-wide impact).
   *   - `cross-source-dev` (sustained): emergency-deleverage the affected
   *     market only.
   *   - other kinds and pre-sustained criticals: log/record only.
   */
  private async runOracleMonitor(): Promise<void> {
    const om = this.deps.oracleMonitor;
    if (!om) return;

    let events: OracleAnomalyEvent[];
    try {
      events = await om.check();
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Oracle monitor check failed');
      return;
    }

    for (const event of events) {
      recordEvent({
        timestamp: new Date(event.timestamp).toISOString(),
        eventType: EventType.ALERT,
        amount: 0,
        asset: event.mint ?? 'USDC',
        sourceProtocol: event.market,
        metadata: {
          action: 'oracle_monitor',
          kind: event.kind,
          severity: event.severity,
          sustained: event.sustained ?? false,
          consecutiveCount: event.consecutiveCount ?? 0,
          ...event.data,
        },
      });

      if (event.severity !== 'critical' || event.sustained !== true) continue;

      try {
        await this.dispatchOracleCriticalAction(event);
      } catch (err) {
        log.error(
          { kind: event.kind, market: event.market, error: (err as Error).message },
          'Oracle action dispatch failed',
        );
        await sendAlert(
          `Oracle action FAILED for ${event.market} (${event.kind}): ${(err as Error).message}`,
          'critical',
        );
      }
    }
  }

  private async dispatchOracleCriticalAction(event: OracleAnomalyEvent): Promise<void> {
    const reason = `oracle:${event.kind} ${event.message}`;

    if (event.kind === 'stable-depeg') {
      // NAV-wide: trip the circuit breaker for all protocols (if wired) AND
      // emergency-deleverage every Multiply position.
      if (this.deps.circuitBreaker) {
        await this.deps.circuitBreaker.trip('*', reason);
      }
      const adapters = this.deps.kaminoMultiplyAdapters ?? [];
      for (const adapter of adapters) {
        try {
          await adapter.emergencyDeleverage();
        } catch (err) {
          log.error(
            { adapter: adapter.name, error: (err as Error).message },
            'emergency deleverage failed during stable-depeg',
          );
        }
      }
      return;
    }

    if (event.kind === 'cross-source-dev') {
      const adapters = this.deps.kaminoMultiplyAdapters ?? [];
      const target = adapters.find(
        (a) => a.getMultiplyConfig().label === event.market,
      );
      if (!target) {
        log.warn({ market: event.market }, 'No multiply adapter matches event market');
        return;
      }
      await target.emergencyDeleverage();
      return;
    }

    // pyth-stale / pyth-confidence / kamino-stale critical paths fall here —
    // currently no automated action; alert only (already sent by emit()).
    log.warn(
      { kind: event.kind, market: event.market },
      'Sustained oracle critical with no automated action wired',
    );
  }

  private async sendStatusDigest(): Promise<void> {
    try {
      const snapshot = await this.getOrBuildSnapshot();
      const config = getConfig();
      const frLatest = this.deps.frMonitor.getLatestAnnualized();
      const fr3d = this.deps.frMonitor.getAverageAnnualized(3);

      // Multiply health rates
      const healthLines: string[] = [];
      if (this.deps.kaminoMultiplyAdapters) {
        for (const adapter of this.deps.kaminoMultiplyAdapters) {
          try {
            const health = await adapter.getHealthRate();
            const cfg = adapter.getMultiplyConfig();
            healthLines.push(`  ${cfg.label}: HR ${health.toFixed(3)}`);
          } catch { /* skip */ }
        }
      }

      const lines = [
        `*State:* ${this.botState}`,
        `*NAV:* $${snapshot.totalNavUsdc.toFixed(2)}`,
        `*Multiply:* $${snapshot.multiplyBalance.toFixed(2)}`,
        `*Lending:* $${snapshot.lendingBalance.toFixed(2)}`,
        `*Buffer:* $${snapshot.bufferUsdcBalance.toFixed(2)}`,
        '',
        `*FR:* ${frLatest.toFixed(1)}% (3d avg: ${fr3d.toFixed(1)}%)`,
        `*SOL:* $${snapshot.solPrice.toFixed(2)}`,
      ];

      if (healthLines.length > 0) {
        lines.push('', '*Health:*', ...healthLines);
      }

      const uptime = Math.floor((Date.now() - this.startedAt) / 3_600_000);
      lines.push('', `*Uptime:* ${uptime}h`);

      await sendAlert(lines.join('\n'), 'info');
      log.debug('Status digest sent');
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to send status digest');
    }
  }

  private async runAdvisor(trigger?: string): Promise<void> {
    if (!this.deps.advisor) return;
    try {
      if (trigger) {
        log.info({ trigger }, 'AI Advisor triggered by event');
      }
      const config = getConfig();
      const recommendations = await this.deps.advisor.evaluate(this.botState, config);
      this.lastAdvisorRunAt = Date.now();
      if (recommendations.length > 0) {
        log.info({ count: recommendations.length, trigger }, 'AI Advisor produced recommendations');
      } else {
        log.debug({ trigger }, 'AI Advisor: no recommendations');
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'AI Advisor evaluation failed');
    }
  }

  /**
   * Check if an event should trigger an advisor run.
   * Called from snapshot and health check flows.
   */
  private async checkAdvisorEventTriggers(snapshot: PortfolioSnapshot, riskScore?: number): Promise<void> {
    if (!this.deps.advisor) return;

    // Cooldown: don't run more than once per 30 minutes
    if (Date.now() - this.lastAdvisorRunAt < Orchestrator.ADVISOR_COOLDOWN_MS) return;

    // 1. SOL price change > 5%
    if (this.lastAdvisorSolPrice > 0 && snapshot.solPrice > 0) {
      const priceDelta = Math.abs(snapshot.solPrice - this.lastAdvisorSolPrice) / this.lastAdvisorSolPrice;
      if (priceDelta >= 0.05) {
        this.lastAdvisorSolPrice = snapshot.solPrice;
        await this.runAdvisor(`sol_price_${priceDelta > 0 ? 'up' : 'down'}_${(priceDelta * 100).toFixed(1)}%`);
        return;
      }
    }
    if (this.lastAdvisorSolPrice === 0) {
      this.lastAdvisorSolPrice = snapshot.solPrice;
    }

    // 2. Risk score jumped above 50 (from below)
    if (riskScore !== undefined) {
      if (riskScore >= 50 && this.lastAdvisorRiskScore < 50) {
        this.lastAdvisorRiskScore = riskScore;
        await this.runAdvisor(`risk_score_spike_${riskScore.toFixed(0)}`);
        return;
      }
      this.lastAdvisorRiskScore = riskScore;
    }

    // 3. FR regime change (sign flip or large move)
    const latestFr = this.deps.frMonitor.getLatestAnnualized();
    if (this.lastAdvisorFrAnnualized !== 0) {
      const frFlipped = (latestFr > 0 && this.lastAdvisorFrAnnualized < 0) ||
                        (latestFr < 0 && this.lastAdvisorFrAnnualized > 0);
      const frBigMove = Math.abs(latestFr - this.lastAdvisorFrAnnualized) > 10; // >10% annualized swing
      if (frFlipped || frBigMove) {
        this.lastAdvisorFrAnnualized = latestFr;
        await this.runAdvisor(`fr_${frFlipped ? 'sign_flip' : 'big_move'}_${latestFr.toFixed(1)}%`);
        return;
      }
    }
    this.lastAdvisorFrAnnualized = latestFr;
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
