import {
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { createChildLogger } from '../utils/logger.js';
import type { DnConnectors } from '../strategies/dn-executor.js';
import type { BinanceRestClient } from './binance/rest.js';
import type { BulkRestClient } from './bulk/rest.js';
import type { BaseAllocator } from '../strategies/base-allocator.js';
import type { JupiterSwap } from './defi/jupiter-swap.js';
import type { SolanaTransactionSender } from './solana/tx-sender.js';
import type { LendingProtocol, VaultConfig } from '../types.js';
import { MINTS } from './defi/types.js';

const log = createChildLogger('dn-connectors');

const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;

// ── Shared helpers ──────────────────────────────────────────────────────

async function findLargestProtocol(
  lendingAdapters: LendingProtocol[],
  baseAllocator: BaseAllocator,
): Promise<LendingProtocol> {
  const allocations = await baseAllocator.getCurrentAllocations();
  let best: LendingProtocol | null = null;
  let bestBalance = 0;

  for (const adapter of lendingAdapters) {
    const balance = allocations.get(adapter.name) ?? 0;
    if (balance > bestBalance) {
      bestBalance = balance;
      best = adapter;
    }
  }

  if (!best) {
    throw new Error('No lending protocol with balance found');
  }
  return best;
}

async function findBestApyProtocol(
  lendingAdapters: LendingProtocol[],
  baseAllocator: BaseAllocator,
): Promise<LendingProtocol> {
  const ranking = await baseAllocator.getApyRanking();
  if (ranking.length === 0) {
    throw new Error('No lending protocols available');
  }
  const bestName = ranking[0]!.protocol;
  const adapter = lendingAdapters.find((a) => a.name === bestName);
  if (!adapter) {
    throw new Error(`Lending protocol ${bestName} not found`);
  }
  return adapter;
}

async function executeJupiterSwap(
  jupiterSwap: JupiterSwap,
  txSender: SolanaTransactionSender,
  inputMint: string,
  outputMint: string,
  amount: number, // in base units
  slippageBps: number,
): Promise<{ outputAmount: number; txSig: string }> {
  const { swapTransaction, quote } = await jupiterSwap.getSwapTransaction(
    inputMint,
    outputMint,
    amount,
    slippageBps,
  );

  const txSig = await txSender.signAndSendBase64(swapTransaction);
  const confirmed = await txSender.confirm(txSig);
  if (!confirmed) {
    throw new Error(`Swap transaction ${txSig} failed to confirm`);
  }

  return { outputAmount: quote.outputAmount, txSig };
}

// ── Binance DN Connectors ───────────────────────────────────────────────

export function buildDnConnectors(deps: {
  binanceRest: BinanceRestClient;
  lendingAdapters: LendingProtocol[];
  baseAllocator: BaseAllocator;
  jupiterSwap: JupiterSwap;
  txSender: SolanaTransactionSender;
  walletAddress: string;
  config: VaultConfig;
  getLatestMarkPrice?: () => number;
}): DnConnectors {
  const {
    binanceRest,
    lendingAdapters,
    baseAllocator,
    jupiterSwap,
    txSender,
    walletAddress,
    config,
  } = deps;

  const dryRun = () => config.general.dryRun;
  const slippageBps = () => config.perp.swapSlippageBps;

  return {
    // 1. withdrawFromLending
    async withdrawFromLending(amount: number): Promise<string> {
      log.info({ amount }, 'withdrawFromLending');

      if (dryRun()) {
        log.info({ amount }, '[DRY RUN] Would withdraw from lending');
        return 'dry-run-withdraw-lending-tx';
      }

      const protocol = await findLargestProtocol(lendingAdapters, baseAllocator);
      log.info({ protocol: protocol.name, amount }, 'Withdrawing from protocol');
      const txSig = await protocol.withdraw(amount);
      log.info({ protocol: protocol.name, amount, txSig }, 'Withdrawal complete');
      return txSig;
    },

    // 2. transferUsdcToBinance
    async transferUsdcToBinance(amount: number): Promise<string> {
      log.info({ amount }, 'transferUsdcToBinance');

      if (dryRun()) {
        log.info({ amount }, '[DRY RUN] Would transfer USDC to Binance');
        return 'dry-run-transfer-usdc-tx';
      }

      // Fetch deposit address from Binance API each time (address may rotate)
      const depositInfo = await binanceRest.getDepositAddress('USDC', 'SOL');
      const depositAddress = depositInfo.address;
      log.info({ depositAddress: `${depositAddress.slice(0, 8)}...` }, 'Got Binance deposit address from API');

      const fromWallet = txSender.publicKey;
      const usdcMint = new PublicKey(MINTS.USDC);

      const fromAta = await getAssociatedTokenAddress(usdcMint, fromWallet);
      // Derive ATA from the Binance-provided wallet (owner) address
      const toOwner = new PublicKey(depositAddress);
      const toAta = await getAssociatedTokenAddress(usdcMint, toOwner);

      const amountBase = Math.floor(amount * 10 ** USDC_DECIMALS);

      // Create destination ATA if it doesn't exist (idempotent — no-op if already exists)
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        fromWallet, // payer
        toAta,
        toOwner,
        usdcMint,
      );

      const transferIx = createTransferInstruction(
        fromAta,
        toAta,
        fromWallet,
        amountBase,
        [],
        TOKEN_PROGRAM_ID,
      );

      const tx = new Transaction().add(createAtaIx, transferIx);
      tx.feePayer = fromWallet;
      const { blockhash } = await txSender.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;

      const txSig = await txSender.signSendConfirm(tx);
      log.info({ amount, txSig }, 'USDC transferred to Binance');
      return txSig;
    },

    // 3. waitForBinanceDeposit
    async waitForBinanceDeposit(
      amount: number,
      timeoutMs: number,
    ): Promise<boolean> {
      log.info({ amount, timeoutMs }, 'waitForBinanceDeposit');

      if (dryRun()) {
        log.info('[DRY RUN] Would wait for Binance deposit');
        return true;
      }

      const start = Date.now();
      const pollInterval = 5_000;

      while (Date.now() - start < timeoutMs) {
        const deposits = await binanceRest.getDepositHistory('USDC');
        // Check for a recent successful deposit matching the amount (within 1% tolerance)
        const match = deposits.find(
          (d) =>
            d.status === 1 &&
            Math.abs(parseFloat(d.amount) - amount) / amount < 0.01 &&
            Date.now() - d.insertTime < timeoutMs,
        );

        if (match) {
          log.info({ depositId: match.id, amount: match.amount }, 'Deposit confirmed');
          return true;
        }

        await new Promise((r) => setTimeout(r, pollInterval));
      }

      log.warn({ amount, timeoutMs }, 'Deposit not confirmed within timeout');
      return false;
    },

    // 4. swapUsdcToDawnSol — on-chain USDC → dawnSOL via Jupiter
    async swapUsdcToDawnSol(
      usdcAmount: number,
    ): Promise<{ dawnsolAmount: number; txSig: string }> {
      log.info({ usdcAmount }, 'swapUsdcToDawnSol');

      if (dryRun()) {
        const mockSol = usdcAmount / 150;
        const mockDawnsol = mockSol * 0.95;
        log.info({ usdcAmount, mockDawnsol }, '[DRY RUN] Would swap USDC -> dawnSOL');
        return {
          dawnsolAmount: mockDawnsol,
          txSig: 'dry-run-swap-usdc-dawnsol-tx',
        };
      }

      const baseUnits = Math.floor(usdcAmount * 10 ** USDC_DECIMALS);
      const { outputAmount, txSig } = await executeJupiterSwap(
        jupiterSwap,
        txSender,
        MINTS.USDC,
        MINTS.DAWNSOL,
        baseUnits,
        slippageBps(),
      );

      const dawnsolAmount = outputAmount / 10 ** SOL_DECIMALS; // dawnSOL has 9 decimals

      log.info({ usdcAmount, dawnsolAmount, txSig }, 'Swapped USDC -> dawnSOL');
      return { dawnsolAmount, txSig };
    },

    // 5. getSolPrice — prefer WebSocket markPrice, fallback to REST
    async getSolPrice(): Promise<number> {
      if (dryRun()) {
        return 150;
      }
      const wsPrice = deps.getLatestMarkPrice?.();
      if (wsPrice && wsPrice > 0) return wsPrice;
      // WebSocket not connected — fallback to REST
      const premiumIndex = await binanceRest.getCurrentFundingRate(config.binance.symbol);
      return parseFloat(premiumIndex.markPrice);
    },

    // 6. openPerpShort
    async openPerpShort(
      solAmount: number,
    ): Promise<{ size: number; entryPrice: number; orderId: string }> {
      log.info({ solAmount }, 'openPerpShort');

      if (dryRun()) {
        log.info({ solAmount }, '[DRY RUN] Would open perp short');
        return { size: solAmount, entryPrice: 150, orderId: 'dry-run-short-order' };
      }

      // Set leverage first
      await binanceRest.setLeverage(config.binance.symbol, config.binance.leverage);

      // Truncate to 3 decimal places for Binance
      const qty = Math.floor(solAmount * 1000) / 1000;

      const order = await binanceRest.placeOrder({
        symbol: config.binance.symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: qty.toString(),
      });

      const result = {
        size: parseFloat(order.executedQty),
        entryPrice: parseFloat(order.avgPrice),
        orderId: order.orderId.toString(),
      };
      log.info(result, 'Perp short opened');
      return result;
    },

    // 7. closePerpShort
    async closePerpShort(): Promise<{ pnl: number; orderId: string }> {
      log.info('closePerpShort');

      if (dryRun()) {
        log.info('[DRY RUN] Would close perp short');
        return { pnl: 0, orderId: 'dry-run-close-order' };
      }

      // Get current position size
      const positions = await binanceRest.getPosition(config.binance.symbol);
      const position = positions.find(
        (p) => parseFloat(p.positionAmt) !== 0,
      );
      if (!position) {
        throw new Error(`No open ${config.binance.symbol} position found`);
      }

      const posSize = Math.abs(parseFloat(position.positionAmt));
      const unrealizedPnl = parseFloat(position.unrealizedProfit);

      // Close by buying back
      const order = await binanceRest.placeOrder({
        symbol: config.binance.symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: posSize.toString(),
        reduceOnly: true,
      });

      const result = {
        pnl: unrealizedPnl,
        orderId: order.orderId.toString(),
      };
      log.info(result, 'Perp short closed');
      return result;
    },

    // 8. swapDawnSolToSol
    async swapDawnSolToSol(
      dawnsolAmount: number,
    ): Promise<{ solAmount: number; txSig: string }> {
      log.info({ dawnsolAmount }, 'swapDawnSolToSol');

      if (dryRun()) {
        const mockSol = dawnsolAmount * 1.05; // approximate ratio
        log.info({ dawnsolAmount, mockSol }, '[DRY RUN] Would swap dawnSOL -> SOL');
        return { solAmount: mockSol, txSig: 'dry-run-swap-dawnsol-sol-tx' };
      }

      const baseUnits = Math.floor(dawnsolAmount * 10 ** SOL_DECIMALS);
      const { outputAmount, txSig } = await executeJupiterSwap(
        jupiterSwap,
        txSender,
        MINTS.DAWNSOL,
        MINTS.SOL,
        baseUnits,
        slippageBps(),
      );

      const solAmount = outputAmount / 10 ** SOL_DECIMALS;
      log.info({ dawnsolAmount, solAmount, txSig }, 'Swapped dawnSOL -> SOL');
      return { solAmount, txSig };
    },

    // 9. swapSolToUsdc
    async swapSolToUsdc(
      solAmount: number,
    ): Promise<{ usdcAmount: number; txSig: string }> {
      log.info({ solAmount }, 'swapSolToUsdc');

      if (dryRun()) {
        const mockUsdc = solAmount * 150;
        log.info({ solAmount, mockUsdc }, '[DRY RUN] Would swap SOL -> USDC');
        return { usdcAmount: mockUsdc, txSig: 'dry-run-swap-sol-usdc-tx' };
      }

      const lamports = Math.floor(solAmount * 10 ** SOL_DECIMALS);
      const { outputAmount, txSig } = await executeJupiterSwap(
        jupiterSwap,
        txSender,
        MINTS.SOL,
        MINTS.USDC,
        lamports,
        slippageBps(),
      );

      const usdcAmount = outputAmount / 10 ** USDC_DECIMALS;
      log.info({ solAmount, usdcAmount, txSig }, 'Swapped SOL -> USDC');
      return { usdcAmount, txSig };
    },

    // 10. transferSpotToFutures
    async transferSpotToFutures(amount: number): Promise<void> {
      log.info({ amount }, 'transferSpotToFutures');

      if (dryRun()) {
        log.info({ amount }, '[DRY RUN] Would transfer USDC from Spot to Futures');
        return;
      }

      await binanceRest.transferSpotToFutures('USDC', amount.toString());
      log.info({ amount }, 'Transferred USDC from Spot to Futures');
    },

    // 11. transferFuturesToSpot
    async transferFuturesToSpot(amount: number): Promise<void> {
      log.info({ amount }, 'transferFuturesToSpot');

      if (dryRun()) {
        log.info({ amount }, '[DRY RUN] Would transfer USDC from Futures to Spot');
        return;
      }

      await binanceRest.transferFuturesToSpot('USDC', amount.toString());
      log.info({ amount }, 'Transferred USDC from Futures to Spot');
    },

    // 12. getFuturesUsdcBalance
    async getFuturesUsdcBalance(): Promise<number> {
      if (dryRun()) {
        return 500; // mock balance
      }

      const balances = await binanceRest.getBalance();
      const usdc = balances.find((b) => b.asset === 'USDC');
      return usdc ? parseFloat(usdc.availableBalance) : 0;
    },

    // 13. depositToLending
    async depositToLending(usdcAmount: number): Promise<string> {
      log.info({ usdcAmount }, 'depositToLending');

      if (dryRun()) {
        log.info({ usdcAmount }, '[DRY RUN] Would deposit to lending');
        return 'dry-run-deposit-lending-tx';
      }

      const protocol = await findBestApyProtocol(lendingAdapters, baseAllocator);
      log.info({ protocol: protocol.name, usdcAmount }, 'Depositing to best APY protocol');
      const txSig = await protocol.deposit(usdcAmount);
      log.info({ protocol: protocol.name, usdcAmount, txSig }, 'Deposit complete');
      return txSig;
    },
  };
}

// ── Bulk DN Connectors ──────────────────────────────────────────────────────

export function buildBulkDnConnectors(deps: {
  bulkRest: BulkRestClient;
  lendingAdapters: LendingProtocol[];
  baseAllocator: BaseAllocator;
  jupiterSwap: JupiterSwap;
  txSender: SolanaTransactionSender;
  walletAddress: string;
  config: VaultConfig;
  getLatestMarkPrice?: () => number;
}): DnConnectors {
  const {
    bulkRest,
    lendingAdapters,
    baseAllocator,
    jupiterSwap,
    txSender,
    config,
  } = deps;

  const dryRun = () => config.general.dryRun;
  const slippageBps = () => config.perp.swapSlippageBps;
  const symbol = () => config.bulk!.symbol;

  return {
    // 1. withdrawFromLending — same as Binance
    async withdrawFromLending(amount: number): Promise<string> {
      log.info({ amount }, 'withdrawFromLending');
      if (dryRun()) return 'dry-run-withdraw-lending-tx';
      const protocol = await findLargestProtocol(lendingAdapters, baseAllocator);
      const txSig = await protocol.withdraw(amount);
      log.info({ protocol: protocol.name, amount, txSig }, 'Withdrawal complete');
      return txSig;
    },

    // 2. transferUsdcToBinance — NO-OP for Bulk (margin is managed on Bulk directly)
    // NOTE: On-chain USDC → Bulk margin deposit requires Bulk's deposit program.
    // For testnet: use BulkRestClient.requestFaucet() to pre-fund the account.
    // For mainnet: this step will be replaced by Bulk's deposit SDK once available.
    async transferUsdcToBinance(_amount: number): Promise<string> {
      log.info('[Bulk] transferUsdcToBinance is a no-op — Bulk manages margin on-chain');
      return 'bulk-no-op-transfer';
    },

    // 3. waitForBinanceDeposit — NO-OP for Bulk
    async waitForBinanceDeposit(_amount: number, _timeoutMs: number): Promise<boolean> {
      log.info('[Bulk] waitForBinanceDeposit is a no-op');
      return true;
    },

    // 4. swapUsdcToDawnSol — same as Binance (Jupiter on-chain swap)
    async swapUsdcToDawnSol(usdcAmount: number): Promise<{ dawnsolAmount: number; txSig: string }> {
      log.info({ usdcAmount }, 'swapUsdcToDawnSol');
      if (dryRun()) {
        return { dawnsolAmount: (usdcAmount / 150) * 0.95, txSig: 'dry-run-swap-usdc-dawnsol-tx' };
      }
      const baseUnits = Math.floor(usdcAmount * 10 ** USDC_DECIMALS);
      const { outputAmount, txSig } = await executeJupiterSwap(jupiterSwap, txSender, MINTS.USDC, MINTS.DAWNSOL, baseUnits, slippageBps());
      const dawnsolAmount = outputAmount / 10 ** SOL_DECIMALS;
      log.info({ usdcAmount, dawnsolAmount, txSig }, 'Swapped USDC -> dawnSOL');
      return { dawnsolAmount, txSig };
    },

    // 5. getSolPrice — prefer WebSocket mark price, fallback to Bulk REST
    async getSolPrice(): Promise<number> {
      if (dryRun()) return 150;
      const wsPrice = deps.getLatestMarkPrice?.();
      if (wsPrice && wsPrice > 0) return wsPrice;
      return bulkRest.getMarkPrice(symbol());
    },

    // 6. openPerpShort — Bulk order
    async openPerpShort(solAmount: number): Promise<{ size: number; entryPrice: number; orderId: string }> {
      log.info({ solAmount }, 'openPerpShort via Bulk');
      if (dryRun()) {
        return { size: solAmount, entryPrice: 150, orderId: 'dry-run-bulk-short' };
      }
      return bulkRest.openShort(symbol(), solAmount);
    },

    // 7. closePerpShort — Bulk order (size determined from live position)
    async closePerpShort(): Promise<{ pnl: number; orderId: string }> {
      log.info('closePerpShort via Bulk');
      if (dryRun()) return { pnl: 0, orderId: 'dry-run-bulk-close' };
      return bulkRest.closeShort(symbol());
    },

    // 8. swapDawnSolToSol — same as Binance (Jupiter on-chain swap)
    async swapDawnSolToSol(dawnsolAmount: number): Promise<{ solAmount: number; txSig: string }> {
      log.info({ dawnsolAmount }, 'swapDawnSolToSol');
      if (dryRun()) return { solAmount: dawnsolAmount * 1.05, txSig: 'dry-run-swap-dawnsol-sol-tx' };
      const baseUnits = Math.floor(dawnsolAmount * 10 ** SOL_DECIMALS);
      const { outputAmount, txSig } = await executeJupiterSwap(jupiterSwap, txSender, MINTS.DAWNSOL, MINTS.SOL, baseUnits, slippageBps());
      const solAmount = outputAmount / 10 ** SOL_DECIMALS;
      log.info({ dawnsolAmount, solAmount, txSig }, 'Swapped dawnSOL -> SOL');
      return { solAmount, txSig };
    },

    // 9. swapSolToUsdc — same as Binance (Jupiter on-chain swap)
    async swapSolToUsdc(solAmount: number): Promise<{ usdcAmount: number; txSig: string }> {
      log.info({ solAmount }, 'swapSolToUsdc');
      if (dryRun()) return { usdcAmount: solAmount * 150, txSig: 'dry-run-swap-sol-usdc-tx' };
      const lamports = Math.floor(solAmount * 10 ** SOL_DECIMALS);
      const { outputAmount, txSig } = await executeJupiterSwap(jupiterSwap, txSender, MINTS.SOL, MINTS.USDC, lamports, slippageBps());
      const usdcAmount = outputAmount / 10 ** USDC_DECIMALS;
      log.info({ solAmount, usdcAmount, txSig }, 'Swapped SOL -> USDC');
      return { usdcAmount, txSig };
    },

    // 10. transferSpotToFutures — NO-OP for Bulk (no CEX wallet separation)
    async transferSpotToFutures(_amount: number): Promise<void> {
      log.info('[Bulk] transferSpotToFutures is a no-op');
    },

    // 11. transferFuturesToSpot — NO-OP for Bulk
    async transferFuturesToSpot(_amount: number): Promise<void> {
      log.info('[Bulk] transferFuturesToSpot is a no-op');
    },

    // 12. getFuturesUsdcBalance — Bulk margin balance
    async getFuturesUsdcBalance(): Promise<number> {
      if (dryRun()) return 500;
      return bulkRest.getMarginBalance();
    },

    // 13. depositToLending — same as Binance
    async depositToLending(usdcAmount: number): Promise<string> {
      log.info({ usdcAmount }, 'depositToLending');
      if (dryRun()) return 'dry-run-deposit-lending-tx';
      const protocol = await findBestApyProtocol(lendingAdapters, baseAllocator);
      const txSig = await protocol.deposit(usdcAmount);
      log.info({ protocol: protocol.name, usdcAmount, txSig }, 'Deposit complete');
      return txSig;
    },
  };
}
