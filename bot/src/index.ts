import 'dotenv/config';
import { createChildLogger } from './utils/logger.js';
import { validateEnv } from './utils/validate-env.js';
import { configManager, getConfig } from './config.js';
import { initDb, closeDb, getDb } from './measurement/db.js';
import { FrMonitor } from './core/fr-monitor.js';
import { BaseAllocator } from './strategies/base-allocator.js';
import { DnExecutor, type DnConnectors } from './strategies/dn-executor.js';
import { RiskManager } from './risk/risk-manager.js';
import { BinanceRestClient } from './connectors/binance/rest.js';
import { BinanceWsClient } from './connectors/binance/ws.js';
import { Orchestrator } from './core/orchestrator.js';
import { sendAlert } from './utils/notify.js';
import { loadWalletFromEnv } from './connectors/solana/wallet.js';
import { KaminoLending } from './connectors/defi/kamino.js';
import { DriftLending } from './connectors/defi/drift.js';
import { JupiterLending } from './connectors/defi/jupiter-lend.js';
import type { LendingProtocol } from './types.js';

const log = createChildLogger('main');

// Stub connectors for DN executor (will be wired to real implementations later)
const stubDnConnectors: DnConnectors = {
  async withdrawFromLending(_amount) { throw new Error('Not implemented'); },
  async transferUsdcToBinance(_amount) { throw new Error('Not implemented'); },
  async waitForBinanceDeposit(_amount, _timeout) { throw new Error('Not implemented'); },
  async buySolOnBinance(_amount) { throw new Error('Not implemented'); },
  async withdrawSolFromBinance(_amount, _addr) { throw new Error('Not implemented'); },
  async waitForSolWithdrawal(_id, _timeout) { throw new Error('Not implemented'); },
  async swapSolToDawnSol(_amount) { throw new Error('Not implemented'); },
  async openPerpShort(_amount) { throw new Error('Not implemented'); },
  async closePerpShort() { throw new Error('Not implemented'); },
  async swapDawnSolToSol(_amount) { throw new Error('Not implemented'); },
  async swapSolToUsdc(_amount) { throw new Error('Not implemented'); },
  async depositToLending(_amount) { throw new Error('Not implemented'); },
};

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

  // Initialize monitors and strategies
  const db = getDb();
  const frMonitor = new FrMonitor(db);
  const baseAllocator = new BaseAllocator(lendingAdapters, config);
  const dnExecutor = new DnExecutor(config, stubDnConnectors, walletAddress);
  const riskManager = new RiskManager(config);

  // Create orchestrator
  const orchestrator = new Orchestrator({
    binanceRest,
    binanceWs,
    frMonitor,
    baseAllocator,
    dnExecutor,
    riskManager,
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
