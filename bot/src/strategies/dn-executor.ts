import type { LedgerEvent, VaultConfig } from '../types.js';
import { EventType } from '../types.js';
import { createChildLogger } from '../utils/logger.js';
import { round } from '../utils/math.js';

const log = createChildLogger('dn-executor');

// ── Step enum ──────────────────────────────────────────────────────────────

export enum DnStep {
  IDLE = 'IDLE',
  // Entry steps
  WITHDRAW_LENDING = 'WITHDRAW_LENDING',
  TRANSFER_TO_BINANCE = 'TRANSFER_TO_BINANCE',
  WAIT_BINANCE_DEPOSIT = 'WAIT_BINANCE_DEPOSIT',
  BUY_SOL_BINANCE = 'BUY_SOL_BINANCE',
  WITHDRAW_SOL_BINANCE = 'WITHDRAW_SOL_BINANCE',
  WAIT_SOL_WITHDRAWAL = 'WAIT_SOL_WITHDRAWAL',
  SWAP_SOL_DAWNSOL = 'SWAP_SOL_DAWNSOL',
  OPEN_PERP_SHORT = 'OPEN_PERP_SHORT',
  ENTRY_COMPLETE = 'ENTRY_COMPLETE',
  // Exit steps
  CLOSE_PERP_SHORT = 'CLOSE_PERP_SHORT',
  SWAP_DAWNSOL_SOL = 'SWAP_DAWNSOL_SOL',
  SWAP_SOL_USDC = 'SWAP_SOL_USDC',
  DEPOSIT_LENDING = 'DEPOSIT_LENDING',
  EXIT_COMPLETE = 'EXIT_COMPLETE',
  // Error
  PARTIAL_ERROR = 'PARTIAL_ERROR',
}

// ── State ──────────────────────────────────────────────────────────────────

export interface DnExecutorState {
  currentStep: DnStep;
  entryAmount: number;
  solAmount: number;
  dawnsolAmount: number;
  perpSize: number;
  perpEntryPrice: number;
  txHistory: { step: DnStep; txSig: string; timestamp: string }[];
  error?: string;
}

// ── Connectors interface ───────────────────────────────────────────────────

export interface DnConnectors {
  withdrawFromLending(amount: number): Promise<string>;
  transferUsdcToBinance(amount: number): Promise<string>;
  waitForBinanceDeposit(amount: number, timeoutMs: number): Promise<boolean>;
  buySolOnBinance(
    usdcAmount: number,
  ): Promise<{ solAmount: number; avgPrice: number; orderId: string }>;
  withdrawSolFromBinance(
    solAmount: number,
    address: string,
  ): Promise<string>;
  waitForSolWithdrawal(
    withdrawId: string,
    timeoutMs: number,
  ): Promise<boolean>;
  swapSolToDawnSol(
    solAmount: number,
  ): Promise<{ dawnsolAmount: number; txSig: string }>;
  openPerpShort(
    solAmount: number,
  ): Promise<{ size: number; entryPrice: number; orderId: string }>;
  closePerpShort(): Promise<{ pnl: number; orderId: string }>;
  swapDawnSolToSol(
    dawnsolAmount: number,
  ): Promise<{ solAmount: number; txSig: string }>;
  swapSolToUsdc(
    solAmount: number,
  ): Promise<{ usdcAmount: number; txSig: string }>;
  depositToLending(usdcAmount: number): Promise<string>;
}

// ── Defaults ───────────────────────────────────────────────────────────────

const BINANCE_DEPOSIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const SOL_WITHDRAWAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

function emptyState(): DnExecutorState {
  return {
    currentStep: DnStep.IDLE,
    entryAmount: 0,
    solAmount: 0,
    dawnsolAmount: 0,
    perpSize: 0,
    perpEntryPrice: 0,
    txHistory: [],
  };
}

// ── Executor ───────────────────────────────────────────────────────────────

export class DnExecutor {
  private state: DnExecutorState;
  private events: LedgerEvent[] = [];
  private config: VaultConfig;
  private connectors: DnConnectors;
  private solanaAddress: string;

  constructor(
    config: VaultConfig,
    connectors: DnConnectors,
    solanaAddress: string,
  ) {
    this.config = config;
    this.connectors = connectors;
    this.solanaAddress = solanaAddress;
    this.state = emptyState();
  }

  getState(): DnExecutorState {
    return { ...this.state };
  }

  getEvents(): LedgerEvent[] {
    return [...this.events];
  }

  // ── Entry flow ─────────────────────────────────────────────────────────

  async startEntry(usdcAmount: number): Promise<DnExecutorState> {
    log.info({ usdcAmount }, 'Starting DN entry');
    this.state = emptyState();
    this.state.entryAmount = usdcAmount;
    this.events = [];

    const entrySteps: DnStep[] = [
      DnStep.WITHDRAW_LENDING,
      DnStep.TRANSFER_TO_BINANCE,
      DnStep.WAIT_BINANCE_DEPOSIT,
      DnStep.BUY_SOL_BINANCE,
      DnStep.WITHDRAW_SOL_BINANCE,
      DnStep.WAIT_SOL_WITHDRAWAL,
      DnStep.SWAP_SOL_DAWNSOL,
      DnStep.OPEN_PERP_SHORT,
    ];

    for (const step of entrySteps) {
      const ok = await this.executeStep(step);
      if (!ok) {
        return this.state;
      }
    }

    this.transition(DnStep.ENTRY_COMPLETE);
    log.info({ state: this.state }, 'DN entry complete');
    return this.state;
  }

  // ── Exit flow ──────────────────────────────────────────────────────────

  async startExit(): Promise<DnExecutorState> {
    log.info('Starting DN exit');
    this.events = [];

    const exitSteps: DnStep[] = [
      DnStep.CLOSE_PERP_SHORT,
      DnStep.SWAP_DAWNSOL_SOL,
      DnStep.SWAP_SOL_USDC,
      DnStep.DEPOSIT_LENDING,
    ];

    for (const step of exitSteps) {
      const ok = await this.executeStep(step);
      if (!ok) {
        return this.state;
      }
    }

    this.transition(DnStep.EXIT_COMPLETE);
    log.info({ state: this.state }, 'DN exit complete');
    return this.state;
  }

  // ── Resume from error ──────────────────────────────────────────────────

  async resumeFromError(): Promise<DnExecutorState> {
    if (this.state.currentStep !== DnStep.PARTIAL_ERROR) {
      log.warn(
        { currentStep: this.state.currentStep },
        'resumeFromError called but not in PARTIAL_ERROR state',
      );
      return this.state;
    }

    const failedStep = this.state.error
      ? this.findFailedStep()
      : DnStep.IDLE;

    if (failedStep === DnStep.IDLE) {
      log.error('Cannot determine failed step to resume from');
      return this.state;
    }

    log.info({ failedStep }, 'Resuming DN execution from failed step');
    this.state.error = undefined;

    // Determine remaining steps based on which flow we're in
    const isEntryStep = this.isEntryStep(failedStep);
    const allSteps = isEntryStep
      ? [
          DnStep.WITHDRAW_LENDING,
          DnStep.TRANSFER_TO_BINANCE,
          DnStep.WAIT_BINANCE_DEPOSIT,
          DnStep.BUY_SOL_BINANCE,
          DnStep.WITHDRAW_SOL_BINANCE,
          DnStep.WAIT_SOL_WITHDRAWAL,
          DnStep.SWAP_SOL_DAWNSOL,
          DnStep.OPEN_PERP_SHORT,
        ]
      : [
          DnStep.CLOSE_PERP_SHORT,
          DnStep.SWAP_DAWNSOL_SOL,
          DnStep.SWAP_SOL_USDC,
          DnStep.DEPOSIT_LENDING,
        ];

    const startIdx = allSteps.indexOf(failedStep);
    const remainingSteps = allSteps.slice(startIdx);

    for (const step of remainingSteps) {
      const ok = await this.executeStep(step);
      if (!ok) {
        return this.state;
      }
    }

    const completeStep = isEntryStep
      ? DnStep.ENTRY_COMPLETE
      : DnStep.EXIT_COMPLETE;
    this.transition(completeStep);
    log.info({ state: this.state }, 'DN resume complete');
    return this.state;
  }

  // ── Step dispatcher ────────────────────────────────────────────────────

  private async executeStep(step: DnStep): Promise<boolean> {
    this.transition(step);
    try {
      switch (step) {
        case DnStep.WITHDRAW_LENDING:
          return await this.stepWithdrawLending();
        case DnStep.TRANSFER_TO_BINANCE:
          return await this.stepTransferToBinance();
        case DnStep.WAIT_BINANCE_DEPOSIT:
          return await this.stepWaitBinanceDeposit();
        case DnStep.BUY_SOL_BINANCE:
          return await this.stepBuySolBinance();
        case DnStep.WITHDRAW_SOL_BINANCE:
          return await this.stepWithdrawSolBinance();
        case DnStep.WAIT_SOL_WITHDRAWAL:
          return await this.stepWaitSolWithdrawal();
        case DnStep.SWAP_SOL_DAWNSOL:
          return await this.stepSwapSolToDawnSol();
        case DnStep.OPEN_PERP_SHORT:
          return await this.stepOpenPerpShort();
        case DnStep.CLOSE_PERP_SHORT:
          return await this.stepClosePerpShort();
        case DnStep.SWAP_DAWNSOL_SOL:
          return await this.stepSwapDawnSolToSol();
        case DnStep.SWAP_SOL_USDC:
          return await this.stepSwapSolToUsdc();
        case DnStep.DEPOSIT_LENDING:
          return await this.stepDepositLending();
        default:
          log.warn({ step }, 'Unknown step');
          return false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ step, error: message }, 'Step failed');
      this.state.currentStep = DnStep.PARTIAL_ERROR;
      this.state.error = `${step}: ${message}`;
      this.events.push({
        timestamp: new Date().toISOString(),
        eventType: EventType.ALERT,
        amount: 0,
        asset: 'USDC',
        metadata: { step, error: message, action: 'dn_step_failed' },
      });
      return false;
    }
  }

  // ── Individual step implementations ────────────────────────────────────

  private async stepWithdrawLending(): Promise<boolean> {
    const txSig = await this.connectors.withdrawFromLending(
      this.state.entryAmount,
    );
    this.recordTx(DnStep.WITHDRAW_LENDING, txSig);
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.WITHDRAW,
      amount: this.state.entryAmount,
      asset: 'USDC',
      txHash: txSig,
      metadata: { action: 'dn_entry_withdraw_lending' },
    });
    log.info({ amount: this.state.entryAmount, txSig }, 'Withdrew from lending');
    return true;
  }

  private async stepTransferToBinance(): Promise<boolean> {
    const txSig = await this.connectors.transferUsdcToBinance(
      this.state.entryAmount,
    );
    this.recordTx(DnStep.TRANSFER_TO_BINANCE, txSig);
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.TRANSFER,
      amount: this.state.entryAmount,
      asset: 'USDC',
      txHash: txSig,
      metadata: { action: 'dn_entry_transfer_to_binance' },
    });
    log.info({ amount: this.state.entryAmount, txSig }, 'USDC transferred to Binance');
    return true;
  }

  private async stepWaitBinanceDeposit(): Promise<boolean> {
    const arrived = await this.connectors.waitForBinanceDeposit(
      this.state.entryAmount,
      BINANCE_DEPOSIT_TIMEOUT_MS,
    );
    if (!arrived) {
      throw new Error(
        `Binance deposit not confirmed within ${BINANCE_DEPOSIT_TIMEOUT_MS / 1000}s`,
      );
    }
    log.info({ amount: this.state.entryAmount }, 'Binance deposit confirmed');
    return true;
  }

  private async stepBuySolBinance(): Promise<boolean> {
    const result = await this.connectors.buySolOnBinance(
      this.state.entryAmount,
    );
    this.state.solAmount = result.solAmount;
    this.recordTx(DnStep.BUY_SOL_BINANCE, result.orderId);
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.SWAP,
      amount: result.solAmount,
      asset: 'SOL',
      price: result.avgPrice,
      orderId: result.orderId,
      metadata: {
        action: 'dn_entry_buy_sol',
        usdcSpent: this.state.entryAmount,
        avgPrice: result.avgPrice,
      },
    });
    log.info(
      { solAmount: result.solAmount, avgPrice: result.avgPrice },
      'Bought SOL on Binance',
    );
    return true;
  }

  private async stepWithdrawSolBinance(): Promise<boolean> {
    const withdrawId = await this.connectors.withdrawSolFromBinance(
      this.state.solAmount,
      this.solanaAddress,
    );
    this.recordTx(DnStep.WITHDRAW_SOL_BINANCE, withdrawId);
    // Store withdrawId in metadata for the wait step
    const lastEntry = this.state.txHistory[this.state.txHistory.length - 1];
    if (lastEntry) lastEntry.txSig = withdrawId;
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.TRANSFER,
      amount: this.state.solAmount,
      asset: 'SOL',
      txHash: withdrawId,
      metadata: {
        action: 'dn_entry_withdraw_sol_binance',
        destinationAddress: this.solanaAddress,
      },
    });
    log.info(
      { solAmount: this.state.solAmount, withdrawId },
      'SOL withdrawal from Binance initiated',
    );
    return true;
  }

  private async stepWaitSolWithdrawal(): Promise<boolean> {
    // Get withdrawId from the previous step
    const withdrawEntry = this.state.txHistory.find(
      (t) => t.step === DnStep.WITHDRAW_SOL_BINANCE,
    );
    const withdrawId = withdrawEntry?.txSig ?? '';

    const arrived = await this.connectors.waitForSolWithdrawal(
      withdrawId,
      SOL_WITHDRAWAL_TIMEOUT_MS,
    );
    if (!arrived) {
      throw new Error(
        `SOL withdrawal not confirmed within ${SOL_WITHDRAWAL_TIMEOUT_MS / 1000}s`,
      );
    }
    log.info({ solAmount: this.state.solAmount }, 'SOL withdrawal confirmed');
    return true;
  }

  private async stepSwapSolToDawnSol(): Promise<boolean> {
    const result = await this.connectors.swapSolToDawnSol(this.state.solAmount);
    this.state.dawnsolAmount = result.dawnsolAmount;
    this.recordTx(DnStep.SWAP_SOL_DAWNSOL, result.txSig);
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.SWAP,
      amount: result.dawnsolAmount,
      asset: 'dawnSOL',
      txHash: result.txSig,
      metadata: {
        action: 'dn_entry_swap_sol_dawnsol',
        solSpent: this.state.solAmount,
        dawnsolReceived: result.dawnsolAmount,
      },
    });
    log.info(
      { solSpent: this.state.solAmount, dawnsolReceived: result.dawnsolAmount },
      'Swapped SOL -> dawnSOL',
    );
    return true;
  }

  private async stepOpenPerpShort(): Promise<boolean> {
    const result = await this.connectors.openPerpShort(this.state.solAmount);
    this.state.perpSize = result.size;
    this.state.perpEntryPrice = result.entryPrice;
    this.recordTx(DnStep.OPEN_PERP_SHORT, result.orderId);
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.PERP_OPEN,
      amount: result.size,
      asset: 'SOL',
      price: result.entryPrice,
      orderId: result.orderId,
      metadata: {
        action: 'dn_entry_open_short',
        size: result.size,
        entryPrice: result.entryPrice,
      },
    });
    log.info(
      { size: result.size, entryPrice: result.entryPrice },
      'Opened PERP short',
    );
    return true;
  }

  private async stepClosePerpShort(): Promise<boolean> {
    const result = await this.connectors.closePerpShort();
    this.recordTx(DnStep.CLOSE_PERP_SHORT, result.orderId);
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.PERP_CLOSE,
      amount: this.state.perpSize,
      asset: 'SOL',
      orderId: result.orderId,
      metadata: {
        action: 'dn_exit_close_short',
        pnl: result.pnl,
        entryPrice: this.state.perpEntryPrice,
      },
    });
    log.info({ pnl: result.pnl }, 'Closed PERP short');
    this.state.perpSize = 0;
    this.state.perpEntryPrice = 0;
    return true;
  }

  private async stepSwapDawnSolToSol(): Promise<boolean> {
    const result = await this.connectors.swapDawnSolToSol(
      this.state.dawnsolAmount,
    );
    this.state.solAmount = result.solAmount;
    this.recordTx(DnStep.SWAP_DAWNSOL_SOL, result.txSig);
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.SWAP,
      amount: result.solAmount,
      asset: 'SOL',
      txHash: result.txSig,
      metadata: {
        action: 'dn_exit_swap_dawnsol_sol',
        dawnsolSpent: this.state.dawnsolAmount,
        solReceived: result.solAmount,
      },
    });
    log.info(
      { dawnsolSpent: this.state.dawnsolAmount, solReceived: result.solAmount },
      'Swapped dawnSOL -> SOL',
    );
    this.state.dawnsolAmount = 0;
    return true;
  }

  private async stepSwapSolToUsdc(): Promise<boolean> {
    const result = await this.connectors.swapSolToUsdc(this.state.solAmount);
    this.recordTx(DnStep.SWAP_SOL_USDC, result.txSig);
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.SWAP,
      amount: result.usdcAmount,
      asset: 'USDC',
      txHash: result.txSig,
      metadata: {
        action: 'dn_exit_swap_sol_usdc',
        solSpent: this.state.solAmount,
        usdcReceived: result.usdcAmount,
      },
    });
    log.info(
      { solSpent: this.state.solAmount, usdcReceived: result.usdcAmount },
      'Swapped SOL -> USDC',
    );
    // Update entryAmount to reflect actual USDC recovered for the deposit step
    this.state.entryAmount = result.usdcAmount;
    this.state.solAmount = 0;
    return true;
  }

  private async stepDepositLending(): Promise<boolean> {
    const txSig = await this.connectors.depositToLending(
      this.state.entryAmount,
    );
    this.recordTx(DnStep.DEPOSIT_LENDING, txSig);
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.DEPOSIT,
      amount: this.state.entryAmount,
      asset: 'USDC',
      txHash: txSig,
      metadata: { action: 'dn_exit_deposit_lending' },
    });
    log.info(
      { amount: this.state.entryAmount, txSig },
      'Deposited USDC to lending',
    );
    return true;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private transition(step: DnStep): void {
    log.info({ from: this.state.currentStep, to: step }, 'Step transition');
    this.state.currentStep = step;
  }

  private recordTx(step: DnStep, txSig: string): void {
    this.state.txHistory.push({
      step,
      txSig,
      timestamp: new Date().toISOString(),
    });
  }

  private findFailedStep(): DnStep {
    // The error string is formatted as "STEP_NAME: error message"
    if (!this.state.error) return DnStep.IDLE;
    const colonIdx = this.state.error.indexOf(':');
    if (colonIdx === -1) return DnStep.IDLE;
    const stepName = this.state.error.substring(0, colonIdx).trim();
    const stepValues = Object.values(DnStep) as string[];
    return stepValues.includes(stepName)
      ? (stepName as DnStep)
      : DnStep.IDLE;
  }

  private isEntryStep(step: DnStep): boolean {
    const entrySteps = new Set([
      DnStep.WITHDRAW_LENDING,
      DnStep.TRANSFER_TO_BINANCE,
      DnStep.WAIT_BINANCE_DEPOSIT,
      DnStep.BUY_SOL_BINANCE,
      DnStep.WITHDRAW_SOL_BINANCE,
      DnStep.WAIT_SOL_WITHDRAWAL,
      DnStep.SWAP_SOL_DAWNSOL,
      DnStep.OPEN_PERP_SHORT,
    ]);
    return entrySteps.has(step);
  }
}
