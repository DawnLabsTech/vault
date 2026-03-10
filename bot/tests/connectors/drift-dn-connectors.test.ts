import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDriftDnConnectors } from '../../src/connectors/dn-connectors.js';
import type { VaultConfig, LendingProtocol } from '../../src/types.js';
import type { DnConnectors } from '../../src/strategies/dn-executor.js';

// ── Test config ────────────────────────────────────────────

function makeConfig(overrides: { dryRun?: boolean } = {}): VaultConfig {
  return {
    general: {
      dryRun: overrides.dryRun ?? true,
      logLevel: 'silent',
      tickIntervalMs: 30_000,
      snapshotIntervalMs: 300_000,
      lendingRebalanceIntervalMs: 21_600_000,
      dailyPnlTimeUtc: '00:00',
    },
    perp: {
      exchange: 'drift',
      symbol: 'SOL-PERP',
      leverage: 1,
      swapSlippageBps: 50,
    },
    binance: {
      symbol: 'SOLUSDC',
      leverage: 1,
      testnet: true,
      swapSlippageBps: 50,
    },
    solana: { network: 'devnet' },
    thresholds: {
      frEntryAnnualized: 10,
      frEntryConfirmationDays: 3,
      frExitAnnualized: 0,
      frExitConfirmationDays: 3,
      frEmergencyAnnualized: -10,
      dnAllocationMax: 0.7,
      lendingRebalanceMinDiffBps: 50,
    },
    risk: {
      dailyLossLimitPct: 2,
      maxPositionCapUsd: 10_000,
      maxTransferSizeUsd: 5_000,
      positionDivergenceThresholdPct: 3,
    },
    lending: {
      protocols: ['kamino', 'drift', 'jupiter'],
      bufferPct: 5,
    },
  };
}

// ── Mock factories ─────────────────────────────────────────

function makeMockLending(name: string, balance = 1000, apy = 0.05): LendingProtocol {
  return {
    name,
    getApy: vi.fn().mockResolvedValue(apy),
    getBalance: vi.fn().mockResolvedValue(balance),
    deposit: vi.fn().mockResolvedValue(`${name}-deposit-tx`),
    withdraw: vi.fn().mockResolvedValue(`${name}-withdraw-tx`),
  };
}

function makeMockDriftPerp() {
  return {
    depositMargin: vi.fn().mockResolvedValue('drift-deposit-margin-tx'),
    withdrawMargin: vi.fn().mockResolvedValue('drift-withdraw-margin-tx'),
    openShort: vi.fn().mockResolvedValue({
      size: 6.66,
      entryPrice: 150.15,
      orderId: 'drift-short-order-1',
    }),
    closeShort: vi.fn().mockResolvedValue({
      pnl: 12.5,
      orderId: 'drift-close-order-1',
    }),
    getUsdcBalance: vi.fn().mockResolvedValue(800.5),
    getSolPrice: vi.fn().mockResolvedValue(150),
    getFundingRate: vi.fn().mockResolvedValue(0.0001),
    cleanup: vi.fn(),
  } as any;
}

function makeMockBaseAllocator(
  allocations: Map<string, number> = new Map([['kamino', 1000]]),
  ranking = [{ protocol: 'kamino', apy: 0.05 }],
) {
  return {
    getCurrentAllocations: vi.fn().mockResolvedValue(allocations),
    getApyRanking: vi.fn().mockResolvedValue(ranking),
  } as any;
}

function makeMockJupiterSwap() {
  return {
    getQuote: vi.fn().mockResolvedValue({
      inputMint: '',
      outputMint: '',
      inputAmount: 1_000_000_000,
      outputAmount: 950_000_000,
      priceImpactPct: 0.01,
      slippageBps: 50,
      routePlan: '[]',
    }),
    getSwapTransaction: vi.fn().mockResolvedValue({
      swapTransaction: 'base64-mock-tx',
      quote: {
        inputMint: '',
        outputMint: '',
        inputAmount: 1_000_000_000,
        outputAmount: 950_000_000,
        priceImpactPct: 0.01,
        slippageBps: 50,
        routePlan: '[]',
      },
    }),
  } as any;
}

function makeMockTxSender() {
  return {
    signAndSendBase64: vi.fn().mockResolvedValue('mock-tx-sig'),
    signAndSend: vi.fn().mockResolvedValue('mock-tx-sig'),
    signSendConfirm: vi.fn().mockResolvedValue('mock-tx-sig'),
    confirm: vi.fn().mockResolvedValue(true),
    publicKey: { toBase58: () => 'MockPublicKey1111111111111111111111111111111' },
    connection: {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: 'mock-blockhash',
        lastValidBlockHeight: 100,
      }),
    },
    keypair: {},
  } as any;
}

function buildTestConnectors(overrides: { dryRun?: boolean } = {}): {
  connectors: DnConnectors;
  mocks: {
    driftPerp: ReturnType<typeof makeMockDriftPerp>;
    lendingAdapters: LendingProtocol[];
    baseAllocator: ReturnType<typeof makeMockBaseAllocator>;
    jupiterSwap: ReturnType<typeof makeMockJupiterSwap>;
    txSender: ReturnType<typeof makeMockTxSender>;
  };
} {
  const driftPerp = makeMockDriftPerp();
  const lendingAdapters = [
    makeMockLending('kamino', 1000, 0.05),
    makeMockLending('drift', 500, 0.04),
  ];
  const baseAllocator = makeMockBaseAllocator(
    new Map([['kamino', 1000], ['drift', 500]]),
    [{ protocol: 'kamino', apy: 0.05 }, { protocol: 'drift', apy: 0.04 }],
  );
  const jupiterSwap = makeMockJupiterSwap();
  const txSender = makeMockTxSender();
  const config = makeConfig(overrides);

  const connectors = buildDriftDnConnectors({
    driftPerp,
    lendingAdapters,
    baseAllocator,
    jupiterSwap,
    txSender,
    walletAddress: 'TestWallet11111111111111111111111111111111111',
    config,
  });

  return {
    connectors,
    mocks: { driftPerp, lendingAdapters, baseAllocator, jupiterSwap, txSender },
  };
}

// ── Tests ──────────────────────────────────────────────────

describe('Drift DN Connectors — dryRun mode', () => {
  let connectors: DnConnectors;

  beforeEach(() => {
    ({ connectors } = buildTestConnectors({ dryRun: true }));
  });

  it('withdrawFromLending returns dry-run tx', async () => {
    const tx = await connectors.withdrawFromLending(500);
    expect(tx).toBe('dry-run-withdraw-lending-tx');
  });

  it('transferUsdcToBinance (=depositMargin) returns dry-run tx', async () => {
    const tx = await connectors.transferUsdcToBinance(500);
    expect(tx).toBe('dry-run-drift-deposit-margin-tx');
  });

  it('waitForBinanceDeposit returns true immediately (no-op)', async () => {
    const result = await connectors.waitForBinanceDeposit(500, 10_000);
    expect(result).toBe(true);
  });

  it('swapUsdcToDawnSol returns mock dawnSOL amount', async () => {
    const result = await connectors.swapUsdcToDawnSol(1500);
    const expectedSol = 1500 / 150;
    const expectedDawnsol = expectedSol * 0.95;
    expect(result.dawnsolAmount).toBeCloseTo(expectedDawnsol, 1);
    expect(result.txSig).toContain('dry-run');
  });

  it('getSolPrice returns mock price', async () => {
    const price = await connectors.getSolPrice();
    expect(price).toBe(150);
  });

  it('openPerpShort returns mock position', async () => {
    const result = await connectors.openPerpShort(10);
    expect(result.size).toBe(10);
    expect(result.entryPrice).toBe(150);
    expect(result.orderId).toContain('dry-run-drift');
  });

  it('closePerpShort returns zero pnl', async () => {
    const result = await connectors.closePerpShort();
    expect(result.pnl).toBe(0);
    expect(result.orderId).toContain('dry-run-drift');
  });

  it('transferSpotToFutures is a no-op', async () => {
    await connectors.transferSpotToFutures(500);
    // Should not throw
  });

  it('transferFuturesToSpot returns without calling Drift in dry-run', async () => {
    await connectors.transferFuturesToSpot(500);
    // Should not throw
  });

  it('getFuturesUsdcBalance returns mock balance', async () => {
    const balance = await connectors.getFuturesUsdcBalance();
    expect(balance).toBe(500);
  });

  it('depositToLending returns dry-run tx', async () => {
    const tx = await connectors.depositToLending(1500);
    expect(tx).toBe('dry-run-deposit-lending-tx');
  });
});

describe('Drift DN Connectors — live mode (mocked deps)', () => {
  let connectors: DnConnectors;
  let mocks: ReturnType<typeof buildTestConnectors>['mocks'];

  beforeEach(() => {
    ({ connectors, mocks } = buildTestConnectors({ dryRun: false }));
  });

  // ── Lending ──────────────────────────────────────────────

  it('withdrawFromLending calls the protocol with largest balance', async () => {
    const tx = await connectors.withdrawFromLending(300);
    expect(tx).toBe('kamino-withdraw-tx');
    expect(mocks.lendingAdapters[0]!.withdraw).toHaveBeenCalledWith(300);
  });

  it('depositToLending uses highest APY protocol', async () => {
    const tx = await connectors.depositToLending(1500);
    expect(tx).toBe('kamino-deposit-tx');
    expect(mocks.lendingAdapters[0]!.deposit).toHaveBeenCalledWith(1500);
  });

  // ── Drift margin ─────────────────────────────────────────

  it('transferUsdcToBinance deposits margin to Drift', async () => {
    const tx = await connectors.transferUsdcToBinance(500);
    expect(mocks.driftPerp.depositMargin).toHaveBeenCalledWith(500);
    expect(tx).toBe('drift-deposit-margin-tx');
  });

  it('waitForBinanceDeposit always returns true (no-op)', async () => {
    const result = await connectors.waitForBinanceDeposit(500, 60_000);
    expect(result).toBe(true);
  });

  it('transferSpotToFutures is a no-op (no Drift call)', async () => {
    await connectors.transferSpotToFutures(500);
    expect(mocks.driftPerp.depositMargin).not.toHaveBeenCalled();
  });

  it('transferFuturesToSpot withdraws margin from Drift', async () => {
    await connectors.transferFuturesToSpot(500);
    expect(mocks.driftPerp.withdrawMargin).toHaveBeenCalledWith(500);
  });

  it('getFuturesUsdcBalance returns Drift account balance', async () => {
    const balance = await connectors.getFuturesUsdcBalance();
    expect(mocks.driftPerp.getUsdcBalance).toHaveBeenCalled();
    expect(balance).toBe(800.5);
  });

  // ── Perp trading ─────────────────────────────────────────

  it('getSolPrice uses Drift oracle', async () => {
    const price = await connectors.getSolPrice();
    expect(mocks.driftPerp.getSolPrice).toHaveBeenCalled();
    expect(price).toBe(150);
  });

  it('openPerpShort calls Drift SDK', async () => {
    const result = await connectors.openPerpShort(10);
    expect(mocks.driftPerp.openShort).toHaveBeenCalledWith(10, 1);
    expect(result.size).toBe(6.66);
    expect(result.entryPrice).toBe(150.15);
    expect(result.orderId).toBe('drift-short-order-1');
  });

  it('closePerpShort calls Drift SDK', async () => {
    const result = await connectors.closePerpShort();
    expect(mocks.driftPerp.closeShort).toHaveBeenCalled();
    expect(result.pnl).toBe(12.5);
    expect(result.orderId).toBe('drift-close-order-1');
  });

  // ── Swaps (same as Binance variant) ──────────────────────

  it('swapUsdcToDawnSol calls Jupiter', async () => {
    const result = await connectors.swapUsdcToDawnSol(1000);
    expect(mocks.jupiterSwap.getSwapTransaction).toHaveBeenCalled();
    expect(mocks.txSender.signAndSendBase64).toHaveBeenCalledWith('base64-mock-tx');
    expect(result.dawnsolAmount).toBeCloseTo(0.95, 2);
    expect(result.txSig).toBe('mock-tx-sig');
  });

  it('swapDawnSolToSol calls Jupiter', async () => {
    const result = await connectors.swapDawnSolToSol(9.5);
    expect(mocks.jupiterSwap.getSwapTransaction).toHaveBeenCalled();
    expect(result.solAmount).toBeCloseTo(0.95, 2);
    expect(result.txSig).toBe('mock-tx-sig');
  });

  it('swapSolToUsdc calls Jupiter', async () => {
    mocks.jupiterSwap.getSwapTransaction.mockResolvedValue({
      swapTransaction: 'base64-mock-tx',
      quote: {
        inputMint: '',
        outputMint: '',
        inputAmount: 10_000_000_000,
        outputAmount: 1_500_000_000,
        priceImpactPct: 0.01,
        slippageBps: 50,
        routePlan: '[]',
      },
    });

    const result = await connectors.swapSolToUsdc(10);
    expect(result.usdcAmount).toBe(1500);
    expect(result.txSig).toBe('mock-tx-sig');
  });
});
