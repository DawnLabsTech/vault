import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDnConnectors } from '../../src/connectors/dn-connectors.js';
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
    binance: {
      symbol: 'SOLUSDT',
      leverage: 1,
      testnet: true,
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

function makeMockBinanceRest() {
  return {
    placeOrder: vi.fn().mockResolvedValue({
      orderId: 12345,
      executedQty: '6.660',
      avgPrice: '150.15',
      cumQuote: '1000.00',
      status: 'FILLED',
      symbol: 'SOLUSDT',
      side: 'BUY',
      type: 'MARKET',
      clientOrderId: '',
      price: '0',
      origQty: '6.660',
      timeInForce: 'GTC',
      reduceOnly: false,
      positionSide: 'BOTH',
      origType: 'MARKET',
      updateTime: Date.now(),
    }),
    withdraw: vi.fn().mockResolvedValue({ id: 'withdraw-id-123' }),
    getDepositHistory: vi.fn().mockResolvedValue([]),
    getWithdrawHistory: vi.fn().mockResolvedValue([]),
    getPosition: vi.fn().mockResolvedValue([
      {
        symbol: 'SOLUSDT',
        positionAmt: '-6.660',
        unrealizedProfit: '12.50',
        entryPrice: '150.15',
        leverage: '1',
        marginType: 'cross',
        markPrice: '148.27',
        liquidationPrice: '0',
        positionSide: 'BOTH',
        notional: '-987.24',
        updateTime: Date.now(),
      },
    ]),
    getCurrentFundingRate: vi.fn().mockResolvedValue({
      symbol: 'SOLUSDT',
      markPrice: '150.00',
      indexPrice: '150.05',
      estimatedSettlePrice: '150.00',
      lastFundingRate: '0.0001',
      nextFundingTime: Date.now() + 3600000,
      interestRate: '0.0001',
      time: Date.now(),
    }),
    setLeverage: vi.fn().mockResolvedValue({
      leverage: 1,
      maxNotionalValue: '1000000',
      symbol: 'SOLUSDT',
    }),
    getBalance: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue({}),
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
    binanceRest: ReturnType<typeof makeMockBinanceRest>;
    lendingAdapters: LendingProtocol[];
    baseAllocator: ReturnType<typeof makeMockBaseAllocator>;
    jupiterSwap: ReturnType<typeof makeMockJupiterSwap>;
    txSender: ReturnType<typeof makeMockTxSender>;
  };
} {
  const binanceRest = makeMockBinanceRest();
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

  const connectors = buildDnConnectors({
    binanceRest,
    lendingAdapters,
    baseAllocator,
    jupiterSwap,
    txSender,
    walletAddress: 'TestWallet11111111111111111111111111111111111',
    config,
  });

  return { connectors, mocks: { binanceRest, lendingAdapters, baseAllocator, jupiterSwap, txSender } };
}

// ── Tests ──────────────────────────────────────────────────

describe('DN Connectors — dryRun mode', () => {
  let connectors: DnConnectors;

  beforeEach(() => {
    ({ connectors } = buildTestConnectors({ dryRun: true }));
  });

  it('withdrawFromLending returns dry-run tx', async () => {
    const tx = await connectors.withdrawFromLending(500);
    expect(tx).toBe('dry-run-withdraw-lending-tx');
  });

  it('transferUsdcToBinance returns dry-run tx', async () => {
    process.env.BINANCE_USDC_DEPOSIT_ADDRESS = 'FakeDepositAddress1111111111111111111111111';
    const tx = await connectors.transferUsdcToBinance(500);
    expect(tx).toBe('dry-run-transfer-usdc-tx');
    delete process.env.BINANCE_USDC_DEPOSIT_ADDRESS;
  });

  it('transferUsdcToBinance throws without env var', async () => {
    delete process.env.BINANCE_USDC_DEPOSIT_ADDRESS;
    await expect(connectors.transferUsdcToBinance(500)).rejects.toThrow(
      'BINANCE_USDC_DEPOSIT_ADDRESS',
    );
  });

  it('waitForBinanceDeposit returns true immediately', async () => {
    const result = await connectors.waitForBinanceDeposit(500, 10_000);
    expect(result).toBe(true);
  });

  it('buySolOnBinance returns mock values', async () => {
    const result = await connectors.buySolOnBinance(1500);
    expect(result.solAmount).toBeCloseTo(10, 0); // 1500 / 150
    expect(result.avgPrice).toBe(150);
    expect(result.orderId).toBe('dry-run-order');
  });

  it('withdrawSolFromBinance returns dry-run id', async () => {
    const id = await connectors.withdrawSolFromBinance(10, 'SomeAddress');
    expect(id).toBe('dry-run-withdraw-sol-id');
  });

  it('waitForSolWithdrawal returns true immediately', async () => {
    const result = await connectors.waitForSolWithdrawal('some-id', 10_000);
    expect(result).toBe(true);
  });

  it('swapSolToDawnSol returns mock dawnSOL amount', async () => {
    const result = await connectors.swapSolToDawnSol(10);
    expect(result.dawnsolAmount).toBeCloseTo(9.5, 1); // 10 * 0.95
    expect(result.txSig).toContain('dry-run');
  });

  it('openPerpShort returns mock position', async () => {
    const result = await connectors.openPerpShort(10);
    expect(result.size).toBe(10);
    expect(result.entryPrice).toBe(150);
    expect(result.orderId).toContain('dry-run');
  });

  it('closePerpShort returns zero pnl', async () => {
    const result = await connectors.closePerpShort();
    expect(result.pnl).toBe(0);
    expect(result.orderId).toContain('dry-run');
  });

  it('swapDawnSolToSol returns mock SOL amount', async () => {
    const result = await connectors.swapDawnSolToSol(9.5);
    expect(result.solAmount).toBeCloseTo(9.975, 2); // 9.5 * 1.05
    expect(result.txSig).toContain('dry-run');
  });

  it('swapSolToUsdc returns mock USDC amount', async () => {
    const result = await connectors.swapSolToUsdc(10);
    expect(result.usdcAmount).toBe(1500); // 10 * 150
    expect(result.txSig).toContain('dry-run');
  });

  it('depositToLending returns dry-run tx', async () => {
    const tx = await connectors.depositToLending(1500);
    expect(tx).toBe('dry-run-deposit-lending-tx');
  });
});

describe('DN Connectors — live mode (mocked deps)', () => {
  let connectors: DnConnectors;
  let mocks: ReturnType<typeof buildTestConnectors>['mocks'];

  beforeEach(() => {
    ({ connectors, mocks } = buildTestConnectors({ dryRun: false }));
  });

  // ── Entry flow ────────────────────────────────────────────

  it('withdrawFromLending calls the protocol with largest balance', async () => {
    const tx = await connectors.withdrawFromLending(300);
    expect(tx).toBe('kamino-withdraw-tx'); // kamino has 1000, drift has 500
    expect(mocks.lendingAdapters[0]!.withdraw).toHaveBeenCalledWith(300);
  });

  it('withdrawFromLending throws when no protocol has balance', async () => {
    mocks.baseAllocator.getCurrentAllocations.mockResolvedValue(new Map());
    await expect(connectors.withdrawFromLending(300)).rejects.toThrow(
      'No lending protocol with balance found',
    );
  });

  it('buySolOnBinance gets price and places market order', async () => {
    const result = await connectors.buySolOnBinance(1000);
    expect(mocks.binanceRest.getCurrentFundingRate).toHaveBeenCalledWith('SOLUSDT');
    expect(mocks.binanceRest.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'SOLUSDT',
        side: 'BUY',
        type: 'MARKET',
      }),
    );
    // Returned from mock order
    expect(result.solAmount).toBe(6.66);
    expect(result.avgPrice).toBe(150.15);
    expect(result.orderId).toBe('12345');
  });

  it('buySolOnBinance truncates quantity to 3 decimals', async () => {
    // price = 150, amount = 1000 → qty = 6.666... → truncated to 6.666
    const result = await connectors.buySolOnBinance(1000);
    const call = mocks.binanceRest.placeOrder.mock.calls[0]![0] as any;
    const qty = parseFloat(call.quantity);
    // Verify it has at most 3 decimal places
    expect(call.quantity).toMatch(/^\d+\.\d{1,3}$/);
    expect(qty).toBeLessThanOrEqual(1000 / 150);
  });

  it('withdrawSolFromBinance calls Binance withdraw', async () => {
    const id = await connectors.withdrawSolFromBinance(5, 'SolAddress123');
    expect(id).toBe('withdraw-id-123');
    expect(mocks.binanceRest.withdraw).toHaveBeenCalledWith(
      'SOL',
      'SolAddress123',
      '5',
      'SOL',
    );
  });

  it('openPerpShort sets leverage then places sell order', async () => {
    const result = await connectors.openPerpShort(10);

    expect(mocks.binanceRest.setLeverage).toHaveBeenCalledWith('SOLUSDT', 1);
    expect(mocks.binanceRest.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'SOLUSDT',
        side: 'SELL',
        type: 'MARKET',
        quantity: '10',
      }),
    );
    expect(result.size).toBe(6.66);
    expect(result.entryPrice).toBe(150.15);
  });

  it('closePerpShort reads position and buys back', async () => {
    const result = await connectors.closePerpShort();

    expect(mocks.binanceRest.getPosition).toHaveBeenCalledWith('SOLUSDT');
    expect(mocks.binanceRest.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'SOLUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: '6.66',
        reduceOnly: true,
      }),
    );
    expect(result.pnl).toBe(12.5);
  });

  it('closePerpShort throws when no position exists', async () => {
    mocks.binanceRest.getPosition.mockResolvedValue([
      { ...makeMockBinanceRest().getPosition.mock.results[0], positionAmt: '0' },
    ]);
    // Override with empty position
    mocks.binanceRest.getPosition.mockResolvedValue([
      {
        symbol: 'SOLUSDT',
        positionAmt: '0',
        unrealizedProfit: '0',
        entryPrice: '0',
        leverage: '1',
        marginType: 'cross',
        markPrice: '150',
        liquidationPrice: '0',
        positionSide: 'BOTH',
        notional: '0',
        updateTime: Date.now(),
      },
    ]);
    await expect(connectors.closePerpShort()).rejects.toThrow(
      'No open SOLUSDT position found',
    );
  });

  // ── Swap methods ──────────────────────────────────────────

  it('swapSolToDawnSol calls Jupiter and confirms', async () => {
    const result = await connectors.swapSolToDawnSol(10);

    expect(mocks.jupiterSwap.getSwapTransaction).toHaveBeenCalledWith(
      expect.any(String), // SOL mint
      expect.any(String), // DAWNSOL mint
      10_000_000_000,     // 10 SOL in lamports
      50,
    );
    expect(mocks.txSender.signAndSendBase64).toHaveBeenCalledWith('base64-mock-tx');
    expect(mocks.txSender.confirm).toHaveBeenCalledWith('mock-tx-sig');
    expect(result.dawnsolAmount).toBeCloseTo(0.95, 2); // 950_000_000 / 1e9
    expect(result.txSig).toBe('mock-tx-sig');
  });

  it('swapDawnSolToSol calls Jupiter with reversed mints', async () => {
    const result = await connectors.swapDawnSolToSol(9.5);

    expect(mocks.jupiterSwap.getSwapTransaction).toHaveBeenCalled();
    expect(result.solAmount).toBeCloseTo(0.95, 2);
    expect(result.txSig).toBe('mock-tx-sig');
  });

  it('swapSolToUsdc converts output to USDC decimals', async () => {
    // Override mock to return USDC-scale output (6 decimals)
    mocks.jupiterSwap.getSwapTransaction.mockResolvedValue({
      swapTransaction: 'base64-mock-tx',
      quote: {
        inputMint: '',
        outputMint: '',
        inputAmount: 10_000_000_000,
        outputAmount: 1_500_000_000, // 1500 USDC in base units (6 decimals)
        priceImpactPct: 0.01,
        slippageBps: 50,
        routePlan: '[]',
      },
    });

    const result = await connectors.swapSolToUsdc(10);
    expect(result.usdcAmount).toBe(1500);
    expect(result.txSig).toBe('mock-tx-sig');
  });

  it('swap throws when confirmation fails', async () => {
    mocks.txSender.confirm.mockResolvedValue(false);

    await expect(connectors.swapSolToDawnSol(10)).rejects.toThrow(
      'failed to confirm',
    );
  });

  // ── Lending deposit ───────────────────────────────────────

  it('depositToLending uses highest APY protocol', async () => {
    const tx = await connectors.depositToLending(1500);
    expect(tx).toBe('kamino-deposit-tx'); // kamino has 0.05 APY > drift 0.04
    expect(mocks.lendingAdapters[0]!.deposit).toHaveBeenCalledWith(1500);
  });

  it('depositToLending throws when no protocols available', async () => {
    mocks.baseAllocator.getApyRanking.mockResolvedValue([]);
    await expect(connectors.depositToLending(1500)).rejects.toThrow(
      'No lending protocols available',
    );
  });
});
