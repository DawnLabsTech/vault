import 'dotenv/config';
import { createChildLogger } from './utils/logger.js';
import { validateEnv } from './utils/validate-env.js';
import { configManager, getConfig } from './config.js';
import { initDb, closeDb, getDb } from './measurement/db.js';
import { FrMonitor } from './core/fr-monitor.js';
import { BaseAllocator } from './strategies/base-allocator.js';
import { CapitalAllocator } from './strategies/capital-allocator.js';
import { DnExecutor } from './strategies/dn-executor.js';
import { RiskManager } from './risk/risk-manager.js';
import { BinanceRestClient } from './connectors/binance/rest.js';
import { BinanceWsClient } from './connectors/binance/ws.js';
import { Orchestrator } from './core/orchestrator.js';
import { sendAlert } from './utils/notify.js';
import { ApiServer } from './api/server.js';
import { loadWalletFromEnv } from './connectors/solana/wallet.js';
import { SolanaRpc } from './connectors/solana/rpc.js';
import { KaminoLending } from './connectors/defi/kamino.js';
import { KaminoLoopLending } from './connectors/defi/kamino-loop.js';
import { KaminoMultiplyLending } from './connectors/defi/kamino-multiply.js';
import { JupiterLending } from './connectors/defi/jupiter-lend.js';
import { JupiterSwap } from './connectors/defi/jupiter-swap.js';
import { SolanaTransactionSender } from './connectors/solana/tx-sender.js';
import { buildDnConnectors } from './connectors/dn-connectors.js';
import { MarketScanner } from './core/market-scanner.js';
import { MultiplyRiskScorer } from './risk/multiply-risk-scorer.js';
import type { LendingProtocol } from './types.js';

const log = createChildLogger('main');

async function main(): Promise<void> {
  log.info('Vault Strategy Bot starting...');

  // Validate environment variables before anything else
  validateEnv();

  const config = getConfig();

  // Initialize database
  initDb();
  log.info('Database initialized');

  // Start config file watching
  configManager.startWatching();

  const perpExchange = config.perp.exchange;
  log.info({ perpExchange }, 'Perp exchange selected');

  // Initialize Binance clients (only when using Binance for perp)
  let binanceRest: BinanceRestClient | null = null;
  let binanceWs: BinanceWsClient | null = null;

  if (perpExchange === 'binance') {
    binanceRest = new BinanceRestClient(
      process.env.BINANCE_API_KEY || '',
      process.env.BINANCE_API_SECRET || '',
      config.binance.testnet,
    );

    binanceWs = new BinanceWsClient(
      config.binance.symbol.toLowerCase(),
      config.binance.testnet,
    );
  }

  // Load wallet and initialize lending adapters
  const rpcUrl = process.env.HELIUS_RPC_URL || '';
  let walletAddress = process.env.SOLANA_WALLET_ADDRESS || '';
  const lendingAdapters: LendingProtocol[] = [];

  try {
    const wallet = loadWalletFromEnv();
    walletAddress = walletAddress || wallet.publicKey;

    for (const protocol of config.lending.protocols) {
      switch (protocol) {
        case 'kamino':
          lendingAdapters.push(new KaminoLending(walletAddress, rpcUrl, wallet.secretKey));
          break;
        case 'kamino-loop':
          lendingAdapters.push(new KaminoLoopLending(walletAddress, rpcUrl, wallet.secretKey, config.kaminoLoop));
          break;
        case 'jupiter':
          lendingAdapters.push(new JupiterLending(walletAddress, rpcUrl, wallet.secretKey));
          break;
        default:
          log.warn({ protocol }, 'Unknown lending protocol, skipping');
      }
    }
    log.info(
      { count: lendingAdapters.length, protocols: lendingAdapters.map((a) => a.name) },
      'Lending adapters initialized with signing capability',
    );
  } catch (err) {
    log.warn(
      { error: (err as Error).message },
      'Wallet not available — lending adapters in read-only mode',
    );
    // Initialize adapters without signing (getApy/getBalance still work)
    for (const protocol of config.lending.protocols) {
      switch (protocol) {
        case 'kamino': lendingAdapters.push(new KaminoLending(walletAddress)); break;
        case 'kamino-loop': lendingAdapters.push(new KaminoLoopLending(walletAddress)); break;
        case 'jupiter': lendingAdapters.push(new JupiterLending(walletAddress)); break;
      }
    }
  }

  // Initialize Jupiter Swap and Solana TX sender
  const jupiterSwap = new JupiterSwap(walletAddress);
  let txSender: SolanaTransactionSender | null = null;
  try {
    const wallet = loadWalletFromEnv();
    if (rpcUrl) {
      txSender = new SolanaTransactionSender(rpcUrl, wallet.secretKey);
    }
  } catch {
    log.warn('TxSender not available — DN connectors will only work in dryRun mode');
  }

  // Initialize monitors and strategies
  const db = getDb();
  const frPeriodsPerDay = 3;
  const frMonitor = new FrMonitor(db, frPeriodsPerDay);
  const baseAllocator = new BaseAllocator(lendingAdapters, config, rpcUrl);

  // Track latest mark price from WebSocket for DN connectors
  let latestMarkPrice = 0;
  if (binanceWs) {
    binanceWs.onMarkPrice((data) => { latestMarkPrice = data.markPrice; });
  }

  // Ensure txSender is available in live mode
  if (!config.general.dryRun && !txSender) {
    throw new Error('TxSender is required in live mode — check SOLANA_PRIVATE_KEY');
  }

  // Build DN connectors
  log.info('Building Binance DN connectors');
  const dnConnectors = buildDnConnectors({
    binanceRest: binanceRest!,
    lendingAdapters,
    baseAllocator,
    jupiterSwap,
    txSender: txSender!,
    walletAddress,
    config,
    getLatestMarkPrice: () => latestMarkPrice,
  });

  const dnExecutor = new DnExecutor(config, dnConnectors, walletAddress);
  const riskManager = new RiskManager(config);

  // Initialize Solana RPC
  const solanaRpc = new SolanaRpc(rpcUrl);

  // Find KaminoLoop adapter for health monitoring
  const kaminoLoop = lendingAdapters.find((a) => a.name === 'kamino-loop') as
    | import('./connectors/defi/kamino-loop.js').KaminoLoopLending
    | undefined;

  // Initialize KaminoMultiply adapters directly from kaminoMultiply config (separate from lending)
  const multiplyConfigs = config.kaminoMultiply ?? [];
  const kaminoMultiplyAdapters: KaminoMultiplyLending[] = [];
  for (const mc of multiplyConfigs) {
    try {
      const wallet = loadWalletFromEnv();
      kaminoMultiplyAdapters.push(new KaminoMultiplyLending(walletAddress, mc, rpcUrl, wallet.secretKey));
    } catch {
      kaminoMultiplyAdapters.push(new KaminoMultiplyLending(walletAddress, mc));
    }
  }
  if (kaminoMultiplyAdapters.length > 0) {
    log.info(
      { count: kaminoMultiplyAdapters.length, labels: kaminoMultiplyAdapters.map((a) => a.getMultiplyConfig().label) },
      'Multiply adapters initialized',
    );
  }

  // Initialize Market Scanner for multiply market rebalancing
  let marketScanner: MarketScanner | null = null;
  const multiplyCandidates = config.kaminoMultiplyCandidates ?? [];
  if (multiplyCandidates.length > 0 && rpcUrl) {
    try {
      const wallet = loadWalletFromEnv();
      const rebalanceConfig = config.multiplyRebalance ?? {
        minDiffBps: 100,
        minHoldingDays: 3,
        scanIntervalMs: 21_600_000,
        paybackWindowDays: 7,
        estimatedSwitchCostBps: 20,
        estimatedSwitchCostUsd: 1,
        minNetGainUsd: 0,
        riskPenalty: [0, 0.005, 0.015] as [number, number, number],
        defaultTargetHealthRate: 1.15,
        defaultAlertHealthRate: 1.10,
        defaultEmergencyHealthRate: 1.05,
      };
      // Initialize risk scorer if config is present
      let riskScorer: MultiplyRiskScorer | null = null;
      if (config.riskScorer) {
        riskScorer = new MultiplyRiskScorer(rpcUrl, config.riskScorer, db);
        log.info('Multiply risk scorer initialized');
      }

      marketScanner = new MarketScanner(
        multiplyCandidates,
        rebalanceConfig,
        rpcUrl,
        walletAddress,
        wallet.secretKey,
        db,
        riskScorer,
        config.risk.maxPositionCapUsd,
      );
      log.info({ candidates: multiplyCandidates.length, riskScorer: !!riskScorer }, 'Market scanner initialized');
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Market scanner initialization failed');
    }
  }

  const capitalAllocator = new CapitalAllocator(
    baseAllocator,
    kaminoMultiplyAdapters,
    config,
    marketScanner,
    rpcUrl,
  );

  // Create orchestrator
  const orchestrator = new Orchestrator({
    binanceRest,
    binanceWs,
    frMonitor,
    baseAllocator,
    capitalAllocator,
    dnExecutor,
    riskManager,
    solanaRpc,
    walletAddress,
    perpExchange,
    kaminoLoop: kaminoLoop ?? null,
    kaminoMultiplyAdapters,
    marketScanner,
  });

  // Start API server
  const apiServer = new ApiServer();
  apiServer.setFrMonitor(frMonitor);
  apiServer.setBaseAllocator(baseAllocator);
  apiServer.setMultiplyAdapters(kaminoMultiplyAdapters);
  apiServer.setMarketScanner(marketScanner);
  apiServer.setPerpExchange(perpExchange);
  apiServer.start(3000);

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutdown signal received');
    await orchestrator.stop();
    apiServer.stop();
    configManager.stopWatching();
    closeDb();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', async (err) => {
    log.fatal({ error: err.message, stack: err.stack }, 'Uncaught exception');
    await sendAlert(`FATAL: Uncaught exception: ${err.message}`, 'critical');
    await shutdown('uncaughtException');
  });
  process.on('unhandledRejection', async (reason) => {
    log.error({ reason }, 'Unhandled rejection');
    await sendAlert(`Unhandled rejection: ${reason}`, 'critical');
  });

  // Start the bot
  await orchestrator.start();

  log.info({
    dryRun: config.general.dryRun,
    perpExchange,
    symbol: config.perp.symbol,
    testnet: config.binance.testnet,
  }, 'Vault Strategy Bot is running');
}

main().catch((err) => {
  log.fatal({ error: (err as Error).message }, 'Failed to start');
  process.exit(1);
});
