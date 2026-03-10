import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DnExecutor, DnStep, type DnConnectors, type DnExecutorState } from './dn-executor.js';
import type { VaultConfig } from '../types.js';

// ── Mock connectors ─────────────────────────────────────────────────────────

function createMockConnectors(overrides?: Partial<DnConnectors>): DnConnectors {
  return {
    withdrawFromLending: vi.fn().mockResolvedValue('tx-withdraw-lending'),
    transferUsdcToBinance: vi.fn().mockResolvedValue('tx-transfer-binance'),
    waitForBinanceDeposit: vi.fn().mockResolvedValue(true),
    swapUsdcToDawnSol: vi.fn().mockResolvedValue({
      dawnsolAmount: 3.2,
      txSig: 'tx-swap-usdc-dawnsol',
    }),
    getSolPrice: vi.fn().mockResolvedValue(150),
    openPerpShort: vi.fn().mockResolvedValue({
      size: 3.333,
      entryPrice: 150,
      orderId: 'order-short',
    }),
    closePerpShort: vi.fn().mockResolvedValue({
      pnl: 5.2,
      orderId: 'order-close-short',
    }),
    swapDawnSolToSol: vi.fn().mockResolvedValue({
      solAmount: 3.4,
      txSig: 'tx-swap-dawnsol-sol',
    }),
    swapSolToUsdc: vi.fn().mockResolvedValue({
      usdcAmount: 510,
      txSig: 'tx-swap-sol-usdc',
    }),
    depositToLending: vi.fn().mockResolvedValue('tx-deposit-lending'),
    transferSpotToFutures: vi.fn().mockResolvedValue(undefined),
    transferFuturesToSpot: vi.fn().mockResolvedValue(undefined),
    getFuturesUsdcBalance: vi.fn().mockResolvedValue(505.2),
    ...overrides,
  };
}

function createMockConfig(): VaultConfig {
  return {
    general: { dryRun: false, tickIntervalMs: 60_000 },
    binance: { symbol: 'SOLUSDC', leverage: 1 },
    dn: {
      frEntryAnnualized: 10,
      frExitAnnualized: 0,
      frEntryConfirmationDays: 3,
      frExitConfirmationDays: 3,
      frEmergencyAnnualized: -10,
      dnAllocationMax: 0.7,
      maxPositionCapUsd: 10_000,
    },
    lending: { bufferPercent: 5, rebalanceThresholdBps: 50 },
    risk: {
      dailyLossLimitPercent: 2,
      maxPositionUsd: 10_000,
      maxTransferUsd: 5_000,
      positionDivergencePercent: 3,
    },
  } as unknown as VaultConfig;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('DnExecutor', () => {
  let connectors: DnConnectors;
  let executor: DnExecutor;

  beforeEach(() => {
    connectors = createMockConnectors();
    executor = new DnExecutor(createMockConfig(), connectors, 'SoLaNaAdDr3ss');
  });

  // ── Entry flow ──────────────────────────────────────────────────────────

  describe('startEntry', () => {
    it('should split USDC equally into margin and long amounts', async () => {
      await executor.startEntry(1000);
      const state = executor.getState();

      expect(state.marginAmount).toBe(500);
      expect(state.longAmount).toBe(500);
    });

    it('should transfer only margin amount to Binance', async () => {
      await executor.startEntry(1000);

      expect(connectors.transferUsdcToBinance).toHaveBeenCalledWith(500);
      expect(connectors.waitForBinanceDeposit).toHaveBeenCalledWith(
        500,
        expect.any(Number),
      );
    });

    it('should withdraw full entry amount from lending', async () => {
      await executor.startEntry(1000);

      expect(connectors.withdrawFromLending).toHaveBeenCalledWith(1000);
    });

    it('should transfer margin from Spot to Futures after deposit', async () => {
      await executor.startEntry(1000);

      expect(connectors.transferSpotToFutures).toHaveBeenCalledWith(500);
    });

    it('should swap long amount USDC to dawnSOL on-chain', async () => {
      await executor.startEntry(1000);

      expect(connectors.swapUsdcToDawnSol).toHaveBeenCalledWith(500);
    });

    it('should open short sized by SOL price', async () => {
      (connectors.getSolPrice as ReturnType<typeof vi.fn>).mockResolvedValue(150);
      await executor.startEntry(1000);

      // shortSolAmount = round(500 / 150, 3) = 3.333
      expect(connectors.openPerpShort).toHaveBeenCalledWith(3.333);
    });

    it('should execute swap and short in parallel (both called)', async () => {
      await executor.startEntry(1000);

      expect(connectors.swapUsdcToDawnSol).toHaveBeenCalledTimes(1);
      expect(connectors.openPerpShort).toHaveBeenCalledTimes(1);
    });

    it('should reach ENTRY_COMPLETE on success', async () => {
      const state = await executor.startEntry(1000);

      expect(state.currentStep).toBe(DnStep.ENTRY_COMPLETE);
      expect(state.dawnsolAmount).toBe(3.2);
      expect(state.perpSize).toBe(3.333);
      expect(state.perpEntryPrice).toBe(150);
    });

    it('should record correct events', async () => {
      await executor.startEntry(1000);
      const events = executor.getEvents();

      const actions = events.map((e) => e.metadata?.action);
      expect(actions).toContain('dn_entry_withdraw_lending');
      expect(actions).toContain('dn_entry_transfer_margin_to_binance');
      expect(actions).toContain('dn_entry_transfer_spot_to_futures');
      expect(actions).toContain('dn_entry_swap_usdc_dawnsol');
      expect(actions).toContain('dn_entry_open_short');
    });

    it('should not call legacy Binance SOL buy/withdraw methods', async () => {
      await executor.startEntry(1000);

      // These methods should not exist on the interface anymore
      expect(connectors).not.toHaveProperty('buySolOnBinance');
      expect(connectors).not.toHaveProperty('withdrawSolFromBinance');
      expect(connectors).not.toHaveProperty('waitForSolWithdrawal');
    });
  });

  // ── Exit flow ───────────────────────────────────────────────────────────

  describe('startExit', () => {
    beforeEach(async () => {
      // Enter first so we have a position
      await executor.startEntry(1000);
    });

    it('should close short and swap dawnSOL in parallel', async () => {
      await executor.startExit();

      expect(connectors.closePerpShort).toHaveBeenCalledTimes(1);
      expect(connectors.swapDawnSolToSol).toHaveBeenCalledWith(3.2); // dawnsolAmount from entry
    });

    it('should transfer Futures USDC to Spot after closing legs', async () => {
      await executor.startExit();

      expect(connectors.getFuturesUsdcBalance).toHaveBeenCalled();
      expect(connectors.transferFuturesToSpot).toHaveBeenCalledWith(505.2);
    });

    it('should swap SOL to USDC after closing both legs', async () => {
      await executor.startExit();

      expect(connectors.swapSolToUsdc).toHaveBeenCalledWith(3.4); // solAmount from swapDawnSolToSol
    });

    it('should deposit recovered USDC to lending', async () => {
      await executor.startExit();

      expect(connectors.depositToLending).toHaveBeenCalledWith(510); // usdcAmount from swapSolToUsdc
    });

    it('should reach EXIT_COMPLETE on success', async () => {
      const state = await executor.startExit();

      expect(state.currentStep).toBe(DnStep.EXIT_COMPLETE);
      expect(state.perpSize).toBe(0);
      expect(state.dawnsolAmount).toBe(0);
      expect(state.solAmount).toBe(0);
    });

    it('should record correct exit events', async () => {
      await executor.startExit();
      const events = executor.getEvents();

      const actions = events.map((e) => e.metadata?.action);
      expect(actions).toContain('dn_exit_close_short');
      expect(actions).toContain('dn_exit_swap_dawnsol_sol');
      expect(actions).toContain('dn_exit_transfer_futures_to_spot');
      expect(actions).toContain('dn_exit_swap_sol_usdc');
      expect(actions).toContain('dn_exit_deposit_lending');
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should transition to PARTIAL_ERROR on step failure', async () => {
      const failConnectors = createMockConnectors({
        waitForBinanceDeposit: vi.fn().mockResolvedValue(false),
      });
      const failExecutor = new DnExecutor(
        createMockConfig(),
        failConnectors,
        'SoLaNaAdDr3ss',
      );

      const state = await failExecutor.startEntry(1000);

      expect(state.currentStep).toBe(DnStep.PARTIAL_ERROR);
      expect(state.error).toContain('WAIT_BINANCE_DEPOSIT');
    });

    it('should transition to PARTIAL_ERROR when swap throws', async () => {
      const failConnectors = createMockConnectors({
        swapUsdcToDawnSol: vi.fn().mockRejectedValue(new Error('Jupiter API down')),
      });
      const failExecutor = new DnExecutor(
        createMockConfig(),
        failConnectors,
        'SoLaNaAdDr3ss',
      );

      const state = await failExecutor.startEntry(1000);

      expect(state.currentStep).toBe(DnStep.PARTIAL_ERROR);
      expect(state.error).toContain('OPEN_BOTH_LEGS');
      expect(state.error).toContain('Jupiter API down');
    });

    it('should transition to PARTIAL_ERROR when short throws', async () => {
      const failConnectors = createMockConnectors({
        openPerpShort: vi.fn().mockRejectedValue(new Error('Insufficient margin')),
      });
      const failExecutor = new DnExecutor(
        createMockConfig(),
        failConnectors,
        'SoLaNaAdDr3ss',
      );

      const state = await failExecutor.startEntry(1000);

      expect(state.currentStep).toBe(DnStep.PARTIAL_ERROR);
      expect(state.error).toContain('OPEN_BOTH_LEGS');
    });

    it('should record swap state when swap succeeds but short fails (entry)', async () => {
      const failConnectors = createMockConnectors({
        openPerpShort: vi.fn().mockRejectedValue(new Error('Insufficient margin')),
      });
      const failExecutor = new DnExecutor(
        createMockConfig(),
        failConnectors,
        'SoLaNaAdDr3ss',
      );

      const state = await failExecutor.startEntry(1000);

      expect(state.currentStep).toBe(DnStep.PARTIAL_ERROR);
      // Swap succeeded — dawnsolAmount must be recorded
      expect(state.dawnsolAmount).toBe(3.2);
      // Short failed — perpSize must remain 0
      expect(state.perpSize).toBe(0);
    });

    it('should record short state when short succeeds but swap fails (entry)', async () => {
      const failConnectors = createMockConnectors({
        swapUsdcToDawnSol: vi.fn().mockRejectedValue(new Error('Jupiter API down')),
      });
      const failExecutor = new DnExecutor(
        createMockConfig(),
        failConnectors,
        'SoLaNaAdDr3ss',
      );

      const state = await failExecutor.startEntry(1000);

      expect(state.currentStep).toBe(DnStep.PARTIAL_ERROR);
      // Short succeeded — perpSize must be recorded
      expect(state.perpSize).toBe(3.333);
      expect(state.perpEntryPrice).toBe(150);
      // Swap failed — dawnsolAmount must remain 0
      expect(state.dawnsolAmount).toBe(0);
    });

    it('should include both errors when both legs fail (entry)', async () => {
      const failConnectors = createMockConnectors({
        swapUsdcToDawnSol: vi.fn().mockRejectedValue(new Error('Jupiter down')),
        openPerpShort: vi.fn().mockRejectedValue(new Error('Binance down')),
      });
      const failExecutor = new DnExecutor(
        createMockConfig(),
        failConnectors,
        'SoLaNaAdDr3ss',
      );

      const state = await failExecutor.startEntry(1000);

      expect(state.currentStep).toBe(DnStep.PARTIAL_ERROR);
      expect(state.error).toContain('Jupiter down');
      expect(state.error).toContain('Binance down');
    });

    it('should record close state when close succeeds but swap fails (exit)', async () => {
      await executor.startEntry(1000);

      const exitConnectors = createMockConnectors({
        swapDawnSolToSol: vi.fn().mockRejectedValue(new Error('Jupiter timeout')),
      });
      const exitExecutor = new DnExecutor(
        createMockConfig(),
        exitConnectors,
        'SoLaNaAdDr3ss',
      );
      // Manually set state to match post-entry
      (exitExecutor as any).state = { ...executor.getState() };

      const state = await exitExecutor.startExit();

      expect(state.currentStep).toBe(DnStep.PARTIAL_ERROR);
      // Close succeeded — perpSize should be 0
      expect(state.perpSize).toBe(0);
      // Swap failed — dawnsolAmount should still have value
      expect(state.dawnsolAmount).toBe(3.2);
    });

    it('should include both errors when both exit legs fail', async () => {
      await executor.startEntry(1000);

      const exitConnectors = createMockConnectors({
        closePerpShort: vi.fn().mockRejectedValue(new Error('Binance maintenance')),
        swapDawnSolToSol: vi.fn().mockRejectedValue(new Error('Jupiter timeout')),
      });
      const exitExecutor = new DnExecutor(
        createMockConfig(),
        exitConnectors,
        'SoLaNaAdDr3ss',
      );
      (exitExecutor as any).state = { ...executor.getState() };

      const state = await exitExecutor.startExit();

      expect(state.currentStep).toBe(DnStep.PARTIAL_ERROR);
      expect(state.error).toContain('Binance maintenance');
      expect(state.error).toContain('Jupiter timeout');
    });

    it('should handle odd USDC amount split correctly', async () => {
      const state = await executor.startEntry(1001);

      expect(state.marginAmount).toBe(500.5);
      expect(state.longAmount).toBe(500.5);
      expect(state.marginAmount + state.longAmount).toBe(1001);
    });
  });

  // ── Resume from error ─────────────────────────────────────────────────

  describe('resumeFromError', () => {
    it('should resume entry from failed step', async () => {
      // Fail on deposit wait, then fix and resume
      let depositCallCount = 0;
      const flaky = createMockConnectors({
        waitForBinanceDeposit: vi.fn().mockImplementation(async () => {
          depositCallCount++;
          if (depositCallCount === 1) return false; // fail first time
          return true; // succeed on retry
        }),
      });
      const flakyExecutor = new DnExecutor(
        createMockConfig(),
        flaky,
        'SoLaNaAdDr3ss',
      );

      // First attempt fails
      const failState = await flakyExecutor.startEntry(1000);
      expect(failState.currentStep).toBe(DnStep.PARTIAL_ERROR);

      // Resume should pick up from WAIT_BINANCE_DEPOSIT
      const resumeState = await flakyExecutor.resumeFromError();
      expect(resumeState.currentStep).toBe(DnStep.ENTRY_COMPLETE);
    });

    it('should resume exit from failed step', async () => {
      await executor.startEntry(1000);

      // Make swapSolToUsdc fail first time
      let callCount = 0;
      (connectors.swapSolToUsdc as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          callCount++;
          if (callCount === 1) throw new Error('slippage too high');
          return { usdcAmount: 510, txSig: 'tx-retry' };
        },
      );

      const failState = await executor.startExit();
      expect(failState.currentStep).toBe(DnStep.PARTIAL_ERROR);

      const resumeState = await executor.resumeFromError();
      expect(resumeState.currentStep).toBe(DnStep.EXIT_COMPLETE);
    });

    it('should skip completed swap leg on entry resume', async () => {
      // Swap succeeds, short fails
      const failConnectors = createMockConnectors({
        openPerpShort: vi.fn()
          .mockRejectedValueOnce(new Error('Insufficient margin'))
          .mockResolvedValue({ size: 3.333, entryPrice: 150, orderId: 'order-retry' }),
      });
      const failExecutor = new DnExecutor(
        createMockConfig(),
        failConnectors,
        'SoLaNaAdDr3ss',
      );

      const failState = await failExecutor.startEntry(1000);
      expect(failState.currentStep).toBe(DnStep.PARTIAL_ERROR);
      expect(failState.dawnsolAmount).toBe(3.2); // swap succeeded

      // Resume — swap should be skipped, only short retried
      const resumeState = await failExecutor.resumeFromError();
      expect(resumeState.currentStep).toBe(DnStep.ENTRY_COMPLETE);
      expect(failConnectors.swapUsdcToDawnSol).toHaveBeenCalledTimes(1); // not called again
      expect(failConnectors.openPerpShort).toHaveBeenCalledTimes(2); // retried
    });

    it('should skip completed close leg on exit resume', async () => {
      await executor.startEntry(1000);

      // Close succeeds, swap fails on first try
      const exitConnectors = createMockConnectors({
        swapDawnSolToSol: vi.fn()
          .mockRejectedValueOnce(new Error('Jupiter timeout'))
          .mockResolvedValue({ solAmount: 3.4, txSig: 'tx-retry' }),
      });
      const exitExecutor = new DnExecutor(
        createMockConfig(),
        exitConnectors,
        'SoLaNaAdDr3ss',
      );
      (exitExecutor as any).state = { ...executor.getState() };

      const failState = await exitExecutor.startExit();
      expect(failState.currentStep).toBe(DnStep.PARTIAL_ERROR);
      expect(failState.perpSize).toBe(0); // close succeeded

      // Resume — close should be skipped, only swap retried
      const resumeState = await exitExecutor.resumeFromError();
      expect(resumeState.currentStep).toBe(DnStep.EXIT_COMPLETE);
      expect(exitConnectors.closePerpShort).toHaveBeenCalledTimes(1); // not called again
      expect(exitConnectors.swapDawnSolToSol).toHaveBeenCalledTimes(2); // retried
    });
  });

  // ── Step ordering ─────────────────────────────────────────────────────

  describe('step ordering', () => {
    it('entry: should call steps in correct order', async () => {
      const callOrder: string[] = [];

      connectors.withdrawFromLending = vi.fn().mockImplementation(async () => {
        callOrder.push('withdrawFromLending');
        return 'tx';
      });
      connectors.transferUsdcToBinance = vi.fn().mockImplementation(async () => {
        callOrder.push('transferUsdcToBinance');
        return 'tx';
      });
      connectors.waitForBinanceDeposit = vi.fn().mockImplementation(async () => {
        callOrder.push('waitForBinanceDeposit');
        return true;
      });
      connectors.transferSpotToFutures = vi.fn().mockImplementation(async () => {
        callOrder.push('transferSpotToFutures');
      });
      connectors.getSolPrice = vi.fn().mockImplementation(async () => {
        callOrder.push('getSolPrice');
        return 150;
      });
      connectors.swapUsdcToDawnSol = vi.fn().mockImplementation(async () => {
        callOrder.push('swapUsdcToDawnSol');
        return { dawnsolAmount: 3.2, txSig: 'tx' };
      });
      connectors.openPerpShort = vi.fn().mockImplementation(async () => {
        callOrder.push('openPerpShort');
        return { size: 3.333, entryPrice: 150, orderId: 'order' };
      });

      await executor.startEntry(1000);

      // Sequential steps must come before parallel ones
      expect(callOrder.indexOf('withdrawFromLending')).toBeLessThan(
        callOrder.indexOf('transferUsdcToBinance'),
      );
      expect(callOrder.indexOf('transferUsdcToBinance')).toBeLessThan(
        callOrder.indexOf('waitForBinanceDeposit'),
      );
      expect(callOrder.indexOf('waitForBinanceDeposit')).toBeLessThan(
        callOrder.indexOf('transferSpotToFutures'),
      );
      expect(callOrder.indexOf('transferSpotToFutures')).toBeLessThan(
        callOrder.indexOf('getSolPrice'),
      );
      // getSolPrice must happen before parallel legs
      expect(callOrder.indexOf('getSolPrice')).toBeLessThan(
        callOrder.indexOf('swapUsdcToDawnSol'),
      );
      expect(callOrder.indexOf('getSolPrice')).toBeLessThan(
        callOrder.indexOf('openPerpShort'),
      );
    });

    it('exit: should close both legs before SOL→USDC swap', async () => {
      await executor.startEntry(1000);

      const callOrder: string[] = [];

      connectors.closePerpShort = vi.fn().mockImplementation(async () => {
        callOrder.push('closePerpShort');
        return { pnl: 5, orderId: 'order' };
      });
      connectors.swapDawnSolToSol = vi.fn().mockImplementation(async () => {
        callOrder.push('swapDawnSolToSol');
        return { solAmount: 3.4, txSig: 'tx' };
      });
      connectors.getFuturesUsdcBalance = vi.fn().mockImplementation(async () => {
        callOrder.push('getFuturesUsdcBalance');
        return 505.2;
      });
      connectors.transferFuturesToSpot = vi.fn().mockImplementation(async () => {
        callOrder.push('transferFuturesToSpot');
      });
      connectors.swapSolToUsdc = vi.fn().mockImplementation(async () => {
        callOrder.push('swapSolToUsdc');
        return { usdcAmount: 510, txSig: 'tx' };
      });
      connectors.depositToLending = vi.fn().mockImplementation(async () => {
        callOrder.push('depositToLending');
        return 'tx';
      });

      await executor.startExit();

      // Both legs close before Futures→Spot transfer before SOL→USDC conversion
      const transferIdx = callOrder.indexOf('transferFuturesToSpot');
      const swapSolIdx = callOrder.indexOf('swapSolToUsdc');
      expect(callOrder.indexOf('closePerpShort')).toBeLessThan(transferIdx);
      expect(callOrder.indexOf('swapDawnSolToSol')).toBeLessThan(transferIdx);
      expect(transferIdx).toBeLessThan(swapSolIdx);
      expect(swapSolIdx).toBeLessThan(callOrder.indexOf('depositToLending'));
    });
  });
});
