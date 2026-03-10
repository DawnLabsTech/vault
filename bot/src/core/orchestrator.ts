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
import { SolanaRpc } from '../connectors/solana/rpc.js';
import { BotState, EventType, ActionType, type PortfolioSnapshot, type Action, type FundingRateData } from '../types.js';
import type { BinanceRestClient } from '../connectors/binance/rest.js';
import type { BinanceWsClient } from '../connectors/binance/ws.js';

const log = createChildLogger('orchestrator');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface OrchestratorDeps {
  binanceRest: BinanceRestClient;
  binanceWs: BinanceWsClient;
  frMonitor: FrMonitor;
  baseAllocator: BaseAllocator;
  dnExecutor: DnExecutor;
  riskManager: RiskManager;
  solanaRpc: SolanaRpc;
  walletAddress: string;
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

    // FR monitoring — every hour
    this.scheduler.register('fr-fetch', 3_600_000, async () => {
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

    // Daily PnL — check every minute, execute at UTC 00:00
    this.scheduler.register('daily-pnl', 60_000, async () => {
      const now = new Date();
      if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
        await this.runDailyPnl();
      }
    });

    // Health check + kill switch — every 5 seconds
    this.scheduler.register('health-check', 5_000, async () => {
      await this.healthCheck();
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

    // Connect Binance WebSocket
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
    this.deps.binanceWs.disconnect();
    this.persistState();
    await sendAlert('Vault Bot stopped', 'info');
    log.info('Orchestrator stopped');
  }

  private async fetchFundingRate(): Promise<void> {
    try {
      const config = getConfig();
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
    const config = getConfig();
    const thresholds = config.thresholds;

    const snapshot = await this.buildSnapshot();

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
  }

  private async executeAction(action: Action): Promise<void> {
    const config = getConfig();

    // Pre-trade risk check
    const snapshot = await this.buildSnapshot();
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
      recordSnapshot(snapshot);
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to take snapshot');
    }
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

    // Get Binance balances
    let binanceUsdcBalance = 0;
    let binancePerpUnrealizedPnl = 0;
    let binancePerpSize = 0;
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

    // dawnSOL (from DN executor state)
    const dnState = this.deps.dnExecutor.getState();
    const dawnsolBalance = dnState.dawnsolAmount;
    const dawnsolUsdcValue = dawnsolBalance * prices.dawnsol;

    const totalNavUsdc = lendingTotal + binanceUsdcBalance + dawnsolUsdcValue + binancePerpUnrealizedPnl;

    return {
      timestamp: new Date().toISOString(),
      totalNavUsdc,
      lendingBalance: lendingTotal,
      lendingBreakdown,
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
      const snapshot = await this.buildSnapshot();
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
