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
  TRANSFER_MARGIN_TO_BINANCE = 'TRANSFER_MARGIN_TO_BINANCE',
  WAIT_BINANCE_DEPOSIT = 'WAIT_BINANCE_DEPOSIT',
  TRANSFER_SPOT_TO_FUTURES = 'TRANSFER_SPOT_TO_FUTURES',
  OPEN_BOTH_LEGS = 'OPEN_BOTH_LEGS', // parallel: USDC→dawnSOL + perp short
  ENTRY_COMPLETE = 'ENTRY_COMPLETE',
  // Exit steps
  CLOSE_BOTH_LEGS = 'CLOSE_BOTH_LEGS', // parallel: close short + dawnSOL→SOL
  TRANSFER_FUTURES_TO_SPOT = 'TRANSFER_FUTURES_TO_SPOT',
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
  marginAmount: number; // USDC sent to Binance as short margin
  longAmount: number; // USDC used for on-chain dawnSOL swap
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
  swapUsdcToDawnSol(
    usdcAmount: number,
  ): Promise<{ dawnsolAmount: number; txSig: string }>;
  getSolPrice(): Promise<number>;
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
  transferSpotToFutures(amount: number): Promise<void>;
  transferFuturesToSpot(amount: number): Promise<void>;
  getFuturesUsdcBalance(): Promise<number>;
}

// ── Defaults ───────────────────────────────────────────────────────────────

const BINANCE_DEPOSIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

function emptyState(): DnExecutorState {
  return {
    currentStep: DnStep.IDLE,
    entryAmount: 0,
    marginAmount: 0,
    longAmount: 0,
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
  //
  // 1. WITHDRAW_LENDING           — withdraw total USDC from lending
  // 2. TRANSFER_MARGIN_TO_BINANCE — send half (margin) to Binance
  // 3. WAIT_BINANCE_DEPOSIT       — wait for deposit confirmation
  // 4. OPEN_BOTH_LEGS (parallel)  — USDC→dawnSOL on-chain + SOL short on Binance
  //

  async startEntry(usdcAmount: number): Promise<DnExecutorState> {
    assertPositiveFinite(usdcAmount, 'Entry amount');
    log.info({ usdcAmount }, 'Starting DN entry');
    this.state = emptyState();
    this.state.entryAmount = usdcAmount;
    // Split: half for Binance margin, half for on-chain dawnSOL
    this.state.marginAmount = round(usdcAmount / 2, 2);
    this.state.longAmount = round(usdcAmount - this.state.marginAmount, 2);
    this.events = [];

    const sequentialSteps: DnStep[] = [
      DnStep.WITHDRAW_LENDING,
      DnStep.TRANSFER_MARGIN_TO_BINANCE,
      DnStep.WAIT_BINANCE_DEPOSIT,
      DnStep.TRANSFER_SPOT_TO_FUTURES,
    ];

    for (const step of sequentialSteps) {
      const ok = await this.executeStep(step);
      if (!ok) {
        return this.state;
      }
    }

    // Open both legs simultaneously to minimize delta exposure
    const ok = await this.executeStep(DnStep.OPEN_BOTH_LEGS);
    if (!ok) {
      return this.state;
    }

    this.transition(DnStep.ENTRY_COMPLETE);
    log.info({ state: this.state }, 'DN entry complete');
    return this.state;
  }

  // ── Exit flow ──────────────────────────────────────────────────────────
  //
  // 1. CLOSE_BOTH_LEGS (parallel) — close short + dawnSOL→SOL simultaneously
  // 2. SWAP_SOL_USDC              — convert SOL back to USDC
  // 3. DEPOSIT_LENDING            — deposit to best APY protocol
  //

  async startExit(): Promise<DnExecutorState> {
    if (this.state.perpSize <= 0 && this.state.dawnsolAmount <= 0 && this.state.solAmount <= 0) {
      log.info('No active DN position to exit');
      return this.state;
    }
    log.info('Starting DN exit');
    this.events = [];

    // Close both legs simultaneously
    let ok = await this.executeStep(DnStep.CLOSE_BOTH_LEGS);
    if (!ok) {
      return this.state;
    }

    for (const step of [DnStep.TRANSFER_FUTURES_TO_SPOT, DnStep.SWAP_SOL_USDC, DnStep.DEPOSIT_LENDING]) {
      ok = await this.executeStep(step);
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

    const isEntry = this.isEntryStep(failedStep);
    const allSteps = isEntry
      ? [
          DnStep.WITHDRAW_LENDING,
          DnStep.TRANSFER_MARGIN_TO_BINANCE,
          DnStep.WAIT_BINANCE_DEPOSIT,
          DnStep.TRANSFER_SPOT_TO_FUTURES,
          DnStep.OPEN_BOTH_LEGS,
        ]
      : [
          DnStep.CLOSE_BOTH_LEGS,
          DnStep.TRANSFER_FUTURES_TO_SPOT,
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

    const completeStep = isEntry
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
        case DnStep.TRANSFER_MARGIN_TO_BINANCE:
          return await this.stepTransferMarginToBinance();
        case DnStep.WAIT_BINANCE_DEPOSIT:
          return await this.stepWaitBinanceDeposit();
        case DnStep.TRANSFER_SPOT_TO_FUTURES:
          return await this.stepTransferSpotToFutures();
        case DnStep.OPEN_BOTH_LEGS:
          return await this.stepOpenBothLegs();
        case DnStep.CLOSE_BOTH_LEGS:
          return await this.stepCloseBothLegs();
        case DnStep.TRANSFER_FUTURES_TO_SPOT:
          return await this.stepTransferFuturesToSpot();
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
    assertPositiveFinite(this.state.entryAmount, 'Lending withdrawal amount');
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

  private async stepTransferMarginToBinance(): Promise<boolean> {
    assertPositiveFinite(this.state.marginAmount, 'Binance margin transfer amount');
    const txSig = await this.connectors.transferUsdcToBinance(
      this.state.marginAmount,
    );
    this.recordTx(DnStep.TRANSFER_MARGIN_TO_BINANCE, txSig);
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.TRANSFER,
      amount: this.state.marginAmount,
      asset: 'USDC',
      txHash: txSig,
      metadata: { action: 'dn_entry_transfer_margin_to_binance' },
    });
    log.info(
      { amount: this.state.marginAmount, txSig },
      'Margin USDC transferred to Binance',
    );
    return true;
  }

  private async stepWaitBinanceDeposit(): Promise<boolean> {
    const arrived = await this.connectors.waitForBinanceDeposit(
      this.state.marginAmount,
      BINANCE_DEPOSIT_TIMEOUT_MS,
    );
    if (!arrived) {
      throw new Error(
        `Binance deposit not confirmed within ${BINANCE_DEPOSIT_TIMEOUT_MS / 1000}s`,
      );
    }
    log.info({ amount: this.state.marginAmount }, 'Binance deposit confirmed');
    return true;
  }

  /**
   * Open both legs in parallel to minimise delta exposure:
   *   - On-chain: USDC → dawnSOL via Jupiter
   *   - Binance:  SOL perpetual short
   *
   * Uses Promise.allSettled so that if one leg fails, the other's result
   * is still recorded in state (critical for irreversible on-chain swaps).
   * Skips already-completed legs on resume.
   */
  private async stepOpenBothLegs(): Promise<boolean> {
    // Get SOL price to size the short leg
    const solPrice = await this.connectors.getSolPrice();
    assertPositiveFinite(solPrice, 'SOL price');
    const shortSolAmount = round(this.state.longAmount / solPrice, 3);
    assertPositiveFinite(shortSolAmount, 'Short SOL amount');

    log.info(
      { longUsdc: this.state.longAmount, shortSol: shortSolAmount, solPrice },
      'Opening both legs in parallel',
    );

    // Skip already-completed legs (for resume after partial failure)
    const swapPromise =
      this.state.dawnsolAmount > 0
        ? Promise.resolve(null)
        : this.connectors.swapUsdcToDawnSol(this.state.longAmount).then((result) => {
          assertPositiveFinite(result.dawnsolAmount, 'dawnSOL amount');
          return result;
        });

    const shortPromise =
      this.state.perpSize > 0
        ? Promise.resolve(null)
        : this.connectors.openPerpShort(shortSolAmount).then((result) => {
          assertPositiveFinite(result.size, 'Perp short size');
          assertPositiveFinite(result.entryPrice, 'Perp entry price');
          return result;
        });

    const [swapSettled, shortSettled] = await Promise.allSettled([
      swapPromise,
      shortPromise,
    ]);

    // Record swap leg if fulfilled
    if (swapSettled.status === 'fulfilled' && swapSettled.value !== null) {
      const swapResult = swapSettled.value;
      this.state.dawnsolAmount = swapResult.dawnsolAmount;
      this.recordTx(DnStep.OPEN_BOTH_LEGS, swapResult.txSig);
      this.events.push({
        timestamp: new Date().toISOString(),
        eventType: EventType.SWAP,
        amount: swapResult.dawnsolAmount,
        asset: 'dawnSOL',
        txHash: swapResult.txSig,
        metadata: {
          action: 'dn_entry_swap_usdc_dawnsol',
          usdcSpent: this.state.longAmount,
          dawnsolReceived: swapResult.dawnsolAmount,
          solEquivalent: shortSolAmount,
        },
      });
    }

    // Record short leg if fulfilled
    if (shortSettled.status === 'fulfilled' && shortSettled.value !== null) {
      const shortResult = shortSettled.value;
      this.state.perpSize = shortResult.size;
      this.state.perpEntryPrice = shortResult.entryPrice;
      this.recordTx(DnStep.OPEN_BOTH_LEGS, shortResult.orderId);
      this.events.push({
        timestamp: new Date().toISOString(),
        eventType: EventType.PERP_OPEN,
        amount: shortResult.size,
        asset: 'SOL',
        price: shortResult.entryPrice,
        orderId: shortResult.orderId,
        metadata: {
          action: 'dn_entry_open_short',
          size: shortResult.size,
          entryPrice: shortResult.entryPrice,
        },
      });
    }

    // Check for failures and throw with details
    const errors: string[] = [];
    if (swapSettled.status === 'rejected') {
      errors.push(`swap: ${swapSettled.reason instanceof Error ? swapSettled.reason.message : String(swapSettled.reason)}`);
    }
    if (shortSettled.status === 'rejected') {
      errors.push(`short: ${shortSettled.reason instanceof Error ? shortSettled.reason.message : String(shortSettled.reason)}`);
    }

    if (errors.length > 0) {
      // Record alert for partial leg failure — position may be unbalanced
      const completedLegs = [];
      if (swapSettled.status === 'fulfilled' && swapSettled.value) completedLegs.push('swap');
      if (shortSettled.status === 'fulfilled' && shortSettled.value) completedLegs.push('short');
      this.events.push({
        timestamp: new Date().toISOString(),
        eventType: EventType.ALERT,
        amount: 0,
        asset: 'SOL',
        metadata: {
          action: 'dn_partial_leg_failure',
          completedLegs,
          failedLegs: errors,
          dawnsolAmount: this.state.dawnsolAmount,
          perpSize: this.state.perpSize,
        },
      });
      log.error({ completedLegs, errors }, 'DN partial leg failure — position may be delta-unbalanced');
      throw new Error(errors.join('; '));
    }

    log.info(
      {
        dawnsolAmount: this.state.dawnsolAmount,
        perpSize: this.state.perpSize,
        perpEntryPrice: this.state.perpEntryPrice,
      },
      'Both legs opened',
    );
    return true;
  }

  /**
   * Close both legs in parallel to minimise delta exposure:
   *   - Binance:  close perpetual short
   *   - On-chain: dawnSOL → SOL via Jupiter
   *
   * Uses Promise.allSettled so that if one leg fails, the other's result
   * is still recorded in state. Skips already-completed legs on resume.
   */
  private async stepCloseBothLegs(): Promise<boolean> {
    log.info(
      { perpSize: this.state.perpSize, dawnsolAmount: this.state.dawnsolAmount },
      'Closing both legs in parallel',
    );

    // Skip already-completed legs (for resume after partial failure)
    const closePromise =
      this.state.perpSize === 0
        ? Promise.resolve(null)
        : this.connectors.closePerpShort();

    const swapPromise =
      this.state.dawnsolAmount === 0
        ? Promise.resolve(null)
        : this.connectors.swapDawnSolToSol(this.state.dawnsolAmount).then((result) => {
          assertPositiveFinite(result.solAmount, 'SOL amount');
          return result;
        });

    const [closeSettled, swapSettled] = await Promise.allSettled([
      closePromise,
      swapPromise,
    ]);

    // Record close short if fulfilled
    if (closeSettled.status === 'fulfilled' && closeSettled.value !== null) {
      const closeResult = closeSettled.value;
      this.recordTx(DnStep.CLOSE_BOTH_LEGS, closeResult.orderId);
      this.events.push({
        timestamp: new Date().toISOString(),
        eventType: EventType.PERP_CLOSE,
        amount: this.state.perpSize,
        asset: 'SOL',
        orderId: closeResult.orderId,
        metadata: {
          action: 'dn_exit_close_short',
          pnl: closeResult.pnl,
          entryPrice: this.state.perpEntryPrice,
        },
      });
      log.info({ pnl: closeResult.pnl }, 'Closed PERP short');
      this.state.perpSize = 0;
      this.state.perpEntryPrice = 0;
    }

    // Record dawnSOL → SOL swap if fulfilled
    if (swapSettled.status === 'fulfilled' && swapSettled.value !== null) {
      const swapResult = swapSettled.value;
      this.state.solAmount = swapResult.solAmount;
      this.recordTx(DnStep.CLOSE_BOTH_LEGS, swapResult.txSig);
      this.events.push({
        timestamp: new Date().toISOString(),
        eventType: EventType.SWAP,
        amount: swapResult.solAmount,
        asset: 'SOL',
        txHash: swapResult.txSig,
        metadata: {
          action: 'dn_exit_swap_dawnsol_sol',
          dawnsolSpent: this.state.dawnsolAmount,
          solReceived: swapResult.solAmount,
        },
      });
      log.info(
        { dawnsolSpent: this.state.dawnsolAmount, solReceived: swapResult.solAmount },
        'Swapped dawnSOL -> SOL',
      );
      this.state.dawnsolAmount = 0;
    }

    // Check for failures and throw with details
    const errors: string[] = [];
    if (closeSettled.status === 'rejected') {
      errors.push(`close: ${closeSettled.reason instanceof Error ? closeSettled.reason.message : String(closeSettled.reason)}`);
    }
    if (swapSettled.status === 'rejected') {
      errors.push(`swap: ${swapSettled.reason instanceof Error ? swapSettled.reason.message : String(swapSettled.reason)}`);
    }

    if (errors.length > 0) {
      const completedLegs = [];
      if (closeSettled.status === 'fulfilled' && closeSettled.value) completedLegs.push('close_short');
      if (swapSettled.status === 'fulfilled' && swapSettled.value) completedLegs.push('swap_dawnsol');
      this.events.push({
        timestamp: new Date().toISOString(),
        eventType: EventType.ALERT,
        amount: 0,
        asset: 'SOL',
        metadata: {
          action: 'dn_partial_leg_failure_close',
          completedLegs,
          failedLegs: errors,
          remainingPerpSize: this.state.perpSize,
          remainingDawnsolAmount: this.state.dawnsolAmount,
        },
      });
      log.error({ completedLegs, errors }, 'DN close partial leg failure — position may be delta-unbalanced');
      throw new Error(errors.join('; '));
    }

    return true;
  }

  private async stepSwapSolToUsdc(): Promise<boolean> {
    assertPositiveFinite(this.state.solAmount, 'SOL amount to swap');
    const result = await this.connectors.swapSolToUsdc(this.state.solAmount);
    assertPositiveFinite(result.usdcAmount, 'Recovered USDC amount');
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
    assertPositiveFinite(this.state.entryAmount, 'Lending deposit amount');
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

  private async stepTransferSpotToFutures(): Promise<boolean> {
    assertPositiveFinite(this.state.marginAmount, 'Spot to Futures transfer amount');
    await this.connectors.transferSpotToFutures(this.state.marginAmount);
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.TRANSFER,
      amount: this.state.marginAmount,
      asset: 'USDC',
      metadata: { action: 'dn_entry_transfer_spot_to_futures' },
    });
    log.info(
      { amount: this.state.marginAmount },
      'Transferred USDC from Spot to Futures',
    );
    return true;
  }

  private async stepTransferFuturesToSpot(): Promise<boolean> {
    const balance = await this.connectors.getFuturesUsdcBalance();
    if (!Number.isFinite(balance)) {
      throw new Error('Futures wallet balance must be a finite number');
    }
    if (balance <= 0) {
      log.info('No USDC balance in Futures wallet, skipping transfer');
      return true;
    }
    await this.connectors.transferFuturesToSpot(balance);
    this.events.push({
      timestamp: new Date().toISOString(),
      eventType: EventType.TRANSFER,
      amount: balance,
      asset: 'USDC',
      metadata: { action: 'dn_exit_transfer_futures_to_spot' },
    });
    log.info(
      { amount: balance },
      'Transferred USDC from Futures to Spot',
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
      DnStep.TRANSFER_MARGIN_TO_BINANCE,
      DnStep.WAIT_BINANCE_DEPOSIT,
      DnStep.TRANSFER_SPOT_TO_FUTURES,
      DnStep.OPEN_BOTH_LEGS,
    ]);
    return entrySteps.has(step);
  }
}
