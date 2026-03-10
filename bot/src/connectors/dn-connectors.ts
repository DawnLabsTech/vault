import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { createChildLogger } from '../utils/logger.js';
import type { DnConnectors } from '../strategies/dn-executor.js';
import type { BinanceRestClient } from './binance/rest.js';
import type { BaseAllocator } from '../strategies/base-allocator.js';
import type { JupiterSwap } from './defi/jupiter-swap.js';
import type { SolanaTransactionSender } from './solana/tx-sender.js';
import type { LendingProtocol, VaultConfig } from '../types.js';
import { MINTS } from './defi/types.js';

const log = createChildLogger('dn-connectors');

const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;

export function buildDnConnectors(deps: {
  binanceRest: BinanceRestClient;
  lendingAdapters: LendingProtocol[];
  baseAllocator: BaseAllocator;
  jupiterSwap: JupiterSwap;
  txSender: SolanaTransactionSender;
  walletAddress: string;
  config: VaultConfig;
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

  // ── Helper: find protocol with largest balance ──────────────────────

  async function findLargestProtocol(): Promise<LendingProtocol> {
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

  // ── Helper: find best APY protocol ─────────────────────────────────

  async function findBestApyProtocol(): Promise<LendingProtocol> {
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

  // ── Helper: Jupiter swap + sign + confirm ──────────────────────────

  async function executeJupiterSwap(
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

  // ── Connectors implementation ──────────────────────────────────────

  return {
    // 1. withdrawFromLending
    async withdrawFromLending(amount: number): Promise<string> {
      log.info({ amount }, 'withdrawFromLending');

      if (dryRun()) {
        log.info({ amount }, '[DRY RUN] Would withdraw from lending');
        return 'dry-run-withdraw-lending-tx';
      }

      const protocol = await findLargestProtocol();
      log.info({ protocol: protocol.name, amount }, 'Withdrawing from protocol');
      const txSig = await protocol.withdraw(amount);
      log.info({ protocol: protocol.name, amount, txSig }, 'Withdrawal complete');
      return txSig;
    },

    // 2. transferUsdcToBinance
    async transferUsdcToBinance(amount: number): Promise<string> {
      log.info({ amount }, 'transferUsdcToBinance');

      const depositAddress = process.env.BINANCE_USDC_DEPOSIT_ADDRESS;
      if (!depositAddress) {
        throw new Error('BINANCE_USDC_DEPOSIT_ADDRESS environment variable not set');
      }

      if (dryRun()) {
        log.info({ amount, depositAddress }, '[DRY RUN] Would transfer USDC to Binance');
        return 'dry-run-transfer-usdc-tx';
      }

      const fromWallet = txSender.publicKey;
      const usdcMint = new PublicKey(MINTS.USDC);
      const toAddress = new PublicKey(depositAddress);

      const fromAta = await getAssociatedTokenAddress(usdcMint, fromWallet);
      const toAta = await getAssociatedTokenAddress(usdcMint, toAddress);

      const amountBase = Math.floor(amount * 10 ** USDC_DECIMALS);

      const ix = createTransferInstruction(
        fromAta,
        toAta,
        fromWallet,
        amountBase,
        [],
        TOKEN_PROGRAM_ID,
      );

      const tx = new Transaction().add(ix);
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

    // 4. buySolOnBinance
    async buySolOnBinance(
      usdcAmount: number,
    ): Promise<{ solAmount: number; avgPrice: number; orderId: string }> {
      log.info({ usdcAmount }, 'buySolOnBinance');

      if (dryRun()) {
        const mockPrice = 150;
        const mockSol = usdcAmount / mockPrice;
        log.info({ usdcAmount, mockSol, mockPrice }, '[DRY RUN] Would buy SOL on Binance');
        return { solAmount: mockSol, avgPrice: mockPrice, orderId: 'dry-run-order' };
      }

      // Get current SOL price to calculate quantity
      const premiumIndex = await binanceRest.getCurrentFundingRate('SOLUSDT');
      const markPrice = parseFloat(premiumIndex.markPrice);
      // Calculate SOL quantity from USDC amount, truncate to 3 decimal places
      const solQty = Math.floor((usdcAmount / markPrice) * 1000) / 1000;

      const order = await binanceRest.placeOrder({
        symbol: 'SOLUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: solQty.toString(),
      });

      const result = {
        solAmount: parseFloat(order.executedQty),
        avgPrice: parseFloat(order.avgPrice),
        orderId: order.orderId.toString(),
      };
      log.info(result, 'SOL purchased on Binance');
      return result;
    },

    // 5. withdrawSolFromBinance
    async withdrawSolFromBinance(
      solAmount: number,
      address: string,
    ): Promise<string> {
      log.info({ solAmount, address: address.slice(0, 8) + '...' }, 'withdrawSolFromBinance');

      if (dryRun()) {
        log.info({ solAmount }, '[DRY RUN] Would withdraw SOL from Binance');
        return 'dry-run-withdraw-sol-id';
      }

      const result = await binanceRest.withdraw(
        'SOL',
        address,
        solAmount.toString(),
        'SOL',
      );
      log.info({ withdrawId: result.id, solAmount }, 'SOL withdrawal initiated');
      return result.id;
    },

    // 6. waitForSolWithdrawal
    async waitForSolWithdrawal(
      withdrawId: string,
      timeoutMs: number,
    ): Promise<boolean> {
      log.info({ withdrawId, timeoutMs }, 'waitForSolWithdrawal');

      if (dryRun()) {
        log.info('[DRY RUN] Would wait for SOL withdrawal');
        return true;
      }

      const start = Date.now();
      const pollInterval = 10_000;

      while (Date.now() - start < timeoutMs) {
        const records = await binanceRest.getWithdrawHistory('SOL');
        const match = records.find((r) => r.id === withdrawId);

        if (match && match.status === 6) {
          log.info({ withdrawId, txId: match.txId }, 'SOL withdrawal completed');
          return true;
        }

        await new Promise((r) => setTimeout(r, pollInterval));
      }

      log.warn({ withdrawId, timeoutMs }, 'SOL withdrawal not confirmed within timeout');
      return false;
    },

    // 7. swapSolToDawnSol
    async swapSolToDawnSol(
      solAmount: number,
    ): Promise<{ dawnsolAmount: number; txSig: string }> {
      log.info({ solAmount }, 'swapSolToDawnSol');

      if (dryRun()) {
        const mockDawnsol = solAmount * 0.95; // approximate ratio
        log.info({ solAmount, mockDawnsol }, '[DRY RUN] Would swap SOL -> dawnSOL');
        return { dawnsolAmount: mockDawnsol, txSig: 'dry-run-swap-sol-dawnsol-tx' };
      }

      const lamports = Math.floor(solAmount * 10 ** SOL_DECIMALS);
      const { outputAmount, txSig } = await executeJupiterSwap(
        MINTS.SOL,
        MINTS.DAWNSOL,
        lamports,
        50,
      );

      const dawnsolAmount = outputAmount / 10 ** SOL_DECIMALS; // dawnSOL has 9 decimals
      log.info({ solAmount, dawnsolAmount, txSig }, 'Swapped SOL -> dawnSOL');
      return { dawnsolAmount, txSig };
    },

    // 8. openPerpShort
    async openPerpShort(
      solAmount: number,
    ): Promise<{ size: number; entryPrice: number; orderId: string }> {
      log.info({ solAmount }, 'openPerpShort');

      if (dryRun()) {
        log.info({ solAmount }, '[DRY RUN] Would open perp short');
        return { size: solAmount, entryPrice: 150, orderId: 'dry-run-short-order' };
      }

      // Set leverage first
      await binanceRest.setLeverage('SOLUSDT', config.binance.leverage);

      // Truncate to 3 decimal places for Binance
      const qty = Math.floor(solAmount * 1000) / 1000;

      const order = await binanceRest.placeOrder({
        symbol: 'SOLUSDT',
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

    // 9. closePerpShort
    async closePerpShort(): Promise<{ pnl: number; orderId: string }> {
      log.info('closePerpShort');

      if (dryRun()) {
        log.info('[DRY RUN] Would close perp short');
        return { pnl: 0, orderId: 'dry-run-close-order' };
      }

      // Get current position size
      const positions = await binanceRest.getPosition('SOLUSDT');
      const position = positions.find(
        (p) => parseFloat(p.positionAmt) !== 0,
      );
      if (!position) {
        throw new Error('No open SOLUSDT position found');
      }

      const posSize = Math.abs(parseFloat(position.positionAmt));
      const unrealizedPnl = parseFloat(position.unrealizedProfit);

      // Close by buying back
      const order = await binanceRest.placeOrder({
        symbol: 'SOLUSDT',
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

    // 10. swapDawnSolToSol
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
        MINTS.DAWNSOL,
        MINTS.SOL,
        baseUnits,
        50,
      );

      const solAmount = outputAmount / 10 ** SOL_DECIMALS;
      log.info({ dawnsolAmount, solAmount, txSig }, 'Swapped dawnSOL -> SOL');
      return { solAmount, txSig };
    },

    // 11. swapSolToUsdc
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
        MINTS.SOL,
        MINTS.USDC,
        lamports,
        50,
      );

      const usdcAmount = outputAmount / 10 ** USDC_DECIMALS;
      log.info({ solAmount, usdcAmount, txSig }, 'Swapped SOL -> USDC');
      return { usdcAmount, txSig };
    },

    // 12. depositToLending
    async depositToLending(usdcAmount: number): Promise<string> {
      log.info({ usdcAmount }, 'depositToLending');

      if (dryRun()) {
        log.info({ usdcAmount }, '[DRY RUN] Would deposit to lending');
        return 'dry-run-deposit-lending-tx';
      }

      const protocol = await findBestApyProtocol();
      log.info({ protocol: protocol.name, usdcAmount }, 'Depositing to best APY protocol');
      const txSig = await protocol.deposit(usdcAmount);
      log.info({ protocol: protocol.name, usdcAmount, txSig }, 'Deposit complete');
      return txSig;
    },
  };
}
