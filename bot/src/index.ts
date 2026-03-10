import 'dotenv/config';
import { createChildLogger } from './utils/logger.js';
import { validateEnv } from './utils/validate-env.js';
import { configManager, getConfig } from './config.js';
import { initDb, closeDb, getDb } from './measurement/db.js';
import { FrMonitor } from './core/fr-monitor.js';
import { BaseAllocator } from './strategies/base-allocator.js';
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
import { DriftLending } from './connectors/defi/drift.js';
import { JupiterLending } from './connectors/defi/jupiter-lend.js';
import { JupiterSwap } from './connectors/defi/jupiter-swap.js';
import { SolanaTransactionSender } from './connectors/solana/tx-sender.js';
import { buildDnConnectors } from './connectors/dn-connectors.js';
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

  // Initialize Binance clients
  const binanceRest = new BinanceRestClient(
    process.env.BINANCE_API_KEY || '',
    process.env.BINANCE_API_SECRET || '',
    config.binance.testnet,
  );

  const binanceWs = new BinanceWsClient(
    config.binance.symbol.toLowerCase(),
    config.binance.testnet,
  );

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
        case 'drift':
          lendingAdapters.push(new DriftLending(walletAddress, rpcUrl, wallet.secretKey));
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
        case 'drift': lendingAdapters.push(new DriftLending(walletAddress)); break;
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
  const frMonitor = new FrMonitor(db);
  const baseAllocator = new BaseAllocator(lendingAdapters, config);

  // Build real DN connectors (dryRun guard is inside each method)
  const dnConnectors = buildDnConnectors({
    binanceRest,
    lendingAdapters,
    baseAllocator,
    jupiterSwap,
    txSender: txSender!,
    walletAddress,
    config,
  });
  const dnExecutor = new DnExecutor(config, dnConnectors, walletAddress);
  const riskManager = new RiskManager(config);

  // Initialize Solana RPC
  const solanaRpc = new SolanaRpc(rpcUrl);

  // Create orchestrator
  const orchestrator = new Orchestrator({
    binanceRest,
    binanceWs,
    frMonitor,
    baseAllocator,
    dnExecutor,
    riskManager,
    solanaRpc,
    walletAddress,
  });

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutdown signal received');
    await orchestrator.stop();
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

  // Start API server
  const apiServer = new ApiServer();
  apiServer.setFrMonitor(frMonitor);
  apiServer.setBaseAllocator(baseAllocator);
  apiServer.start(3000);

  // Start the bot
  await orchestrator.start();

  log.info({
    dryRun: config.general.dryRun,
    testnet: config.binance.testnet,
    symbol: config.binance.symbol,
  }, 'Vault Strategy Bot is running');
}

main().catch((err) => {
  log.fatal({ error: (err as Error).message }, 'Failed to start');
  process.exit(1);
});
