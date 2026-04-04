#!/usr/bin/env tsx
/**
 * Binance 少額テスト: 入金 → perp short open → perp short close → 出金
 *
 * Usage:
 *   npx tsx scripts/test-binance-flow.ts                # 全ステップ実行
 *   npx tsx scripts/test-binance-flow.ts --step deposit # 個別ステップ
 *   npx tsx scripts/test-binance-flow.ts --step short
 *   npx tsx scripts/test-binance-flow.ts --step close
 *   npx tsx scripts/test-binance-flow.ts --step withdraw
 *   npx tsx scripts/test-binance-flow.ts --step status  # 残高・ポジション確認のみ
 *
 * Options:
 *   --amount <USDC>   入金額 (default: 16)
 *   --sol <SOL>       ショート数量 (default: 0.1 = 最小注文)
 *   --yes             確認プロンプトをスキップ
 */
import 'dotenv/config';
import { createInterface } from 'readline';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { BinanceRestClient } from '../src/connectors/binance/rest.js';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';
import { SolanaTransactionSender } from '../src/connectors/solana/tx-sender.js';

// ── Config ──────────────────────────────────────────────────────────────

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;
const SYMBOL = 'SOLUSDC';

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}
const step = getArg('step') || 'all';
const depositAmount = parseFloat(getArg('amount') || '16');
const shortSol = parseFloat(getArg('sol') || '0.1');
const skipConfirm = args.includes('--yes');

// ── Helpers ─────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg: string): void {
  console.log(`[${now()}] ${msg}`);
}

async function confirm(msg: string): Promise<boolean> {
  if (skipConfirm) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n⚠️  ${msg} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

async function sleep(ms: number, label?: string): Promise<void> {
  if (label) log(`⏳ ${label} (${ms / 1000}s)...`);
  await new Promise((r) => setTimeout(r, ms));
}

// ── Initialize clients ──────────────────────────────────────────────────

function initClients() {
  const apiKey = process.env.BINANCE_API_KEY || '';
  const apiSecret = process.env.BINANCE_API_SECRET || '';
  const rpcUrl = process.env.HELIUS_RPC_URL || '';

  if (!apiKey || !apiSecret) throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET not set');
  if (!rpcUrl) throw new Error('HELIUS_RPC_URL not set');

  const binance = new BinanceRestClient(apiKey, apiSecret, false);
  const wallet = loadWalletFromEnv();
  const txSender = new SolanaTransactionSender(rpcUrl, wallet.secretKey);

  return { binance, txSender, wallet, rpcUrl };
}

// ── Step: Status ────────────────────────────────────────────────────────

async function showStatus(binance: BinanceRestClient) {
  console.log('\n=== Binance Status ===');

  // Futures balance
  const balances = await binance.getBalance();
  const usdc = balances.find((b) => b.asset === 'USDC');
  const usdt = balances.find((b) => b.asset === 'USDT');
  console.log(`  Futures USDC: ${usdc ? parseFloat(usdc.balance).toFixed(2) : '0.00'} (available: ${usdc ? parseFloat(usdc.availableBalance).toFixed(2) : '0.00'})`);
  console.log(`  Futures USDT: ${usdt ? parseFloat(usdt.balance).toFixed(2) : '0.00'}`);

  // Position
  const positions = await binance.getPosition(SYMBOL);
  const active = positions.filter((p) => parseFloat(p.positionAmt) !== 0);
  if (active.length === 0) {
    console.log('  Position: none');
  } else {
    for (const p of active) {
      console.log(`  Position: ${p.positionAmt} SOL @ $${parseFloat(p.entryPrice).toFixed(2)}, uPnL: $${parseFloat(p.unrealizedProfit).toFixed(4)}`);
    }
  }

  // Mark price
  const pi = await binance.getCurrentFundingRate(SYMBOL);
  console.log(`  Mark Price: $${parseFloat(pi.markPrice).toFixed(2)}`);
  console.log(`  FR: ${(parseFloat(pi.lastFundingRate) * 100).toFixed(4)}%`);
}

// ── Step 1: Deposit USDC to Binance ─────────────────────────────────────

async function stepDeposit(
  txSender: SolanaTransactionSender,
  binance: BinanceRestClient,
  amount: number,
): Promise<string> {
  // Fetch deposit address from Binance API (address may rotate)
  const depositInfo = await binance.getDepositAddress('USDC', 'SOL');
  const depositAddr = depositInfo.address;

  log(`Depositing ${amount} USDC to Binance (${depositAddr.slice(0, 8)}... via API)`);

  const ok = await confirm(`Send ${amount} USDC on-chain to Binance?`);
  if (!ok) throw new Error('Cancelled by user');

  const fromWallet = txSender.publicKey;
  const fromAta = await getAssociatedTokenAddress(USDC_MINT, fromWallet);
  // Derive ATA from the Binance-provided wallet (owner) address
  const toOwner = new PublicKey(depositAddr);
  const toAta = await getAssociatedTokenAddress(USDC_MINT, toOwner);
  const amountBase = Math.floor(amount * 10 ** USDC_DECIMALS);

  // Create destination ATA if it doesn't exist (idempotent)
  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    fromWallet,
    toAta,
    toOwner,
    USDC_MINT,
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
  log(`✅ On-chain TX: ${txSig}`);
  log(`   https://solscan.io/tx/${txSig}`);
  return txSig;
}

// ── Step 1b: Wait for Binance deposit ───────────────────────────────────

async function waitDeposit(binance: BinanceRestClient, amount: number): Promise<boolean> {
  log(`Waiting for Binance deposit confirmation (~${amount} USDC)...`);
  const start = Date.now();
  const timeoutMs = 10 * 60 * 1000; // 10 min
  const pollInterval = 10_000;

  while (Date.now() - start < timeoutMs) {
    const deposits = await binance.getDepositHistory('USDC');
    const match = deposits.find(
      (d) =>
        d.status === 1 &&
        Math.abs(parseFloat(d.amount) - amount) / amount < 0.05 &&
        Date.now() - d.insertTime < timeoutMs,
    );
    if (match) {
      log(`✅ Deposit confirmed: ${match.amount} USDC (txId: ${match.txId?.slice(0, 16)}...)`);
      return true;
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    process.stdout.write(`\r  Polling... ${elapsed}s elapsed`);
    await sleep(pollInterval);
  }
  log('❌ Deposit not confirmed within 10 minutes');
  return false;
}

// ── Step 1c: Transfer Spot → Futures ────────────────────────────────────

async function stepSpotToFutures(binance: BinanceRestClient, amount: number): Promise<void> {
  log(`Transferring ${amount} USDC from Spot to Futures wallet...`);
  const result = await binance.transferSpotToFutures('USDC', amount.toString());
  log(`✅ Spot → Futures transfer done (tranId: ${result.tranId})`);
}

// ── Step 2: Open perp short ─────────────────────────────────────────────

async function stepOpenShort(
  binance: BinanceRestClient,
  solAmount: number,
): Promise<{ size: number; entryPrice: number; orderId: string }> {
  const pi = await binance.getCurrentFundingRate(SYMBOL);
  const markPrice = parseFloat(pi.markPrice);
  const notional = solAmount * markPrice;

  log(`Opening ${solAmount} SOL short (~$${notional.toFixed(2)} notional) @ mark $${markPrice.toFixed(2)}`);

  const ok = await confirm(`Open ${solAmount} SOL perp short on Binance?`);
  if (!ok) throw new Error('Cancelled by user');

  // Set leverage
  await binance.setLeverage(SYMBOL, 1);

  const qty = Math.floor(solAmount * 1000) / 1000;
  const order = await binance.placeOrder({
    symbol: SYMBOL,
    side: 'SELL',
    type: 'MARKET',
    quantity: qty.toString(),
  });

  const result = {
    size: parseFloat(order.executedQty),
    entryPrice: parseFloat(order.avgPrice),
    orderId: order.orderId.toString(),
  };
  log(`✅ Short opened: ${result.size} SOL @ $${result.entryPrice.toFixed(2)} (orderId: ${result.orderId})`);
  return result;
}

// ── Step 3: Close perp short ────────────────────────────────────────────

async function stepCloseShort(
  binance: BinanceRestClient,
): Promise<{ pnl: number; orderId: string }> {
  const positions = await binance.getPosition(SYMBOL);
  const position = positions.find((p) => parseFloat(p.positionAmt) !== 0);
  if (!position) throw new Error(`No open ${SYMBOL} position found`);

  const posSize = Math.abs(parseFloat(position.positionAmt));
  const unrealizedPnl = parseFloat(position.unrealizedProfit);

  log(`Closing ${posSize} SOL short (unrealized PnL: $${unrealizedPnl.toFixed(4)})`);

  const ok = await confirm(`Close ${posSize} SOL perp short?`);
  if (!ok) throw new Error('Cancelled by user');

  const order = await binance.placeOrder({
    symbol: SYMBOL,
    side: 'BUY',
    type: 'MARKET',
    quantity: posSize.toString(),
    reduceOnly: true,
  });

  const result = {
    pnl: unrealizedPnl,
    orderId: order.orderId.toString(),
  };
  log(`✅ Short closed: PnL $${result.pnl.toFixed(4)} (orderId: ${result.orderId})`);
  return result;
}

// ── Step 4: Withdraw USDC from Binance ──────────────────────────────────

async function stepWithdraw(
  binance: BinanceRestClient,
  walletAddress: string,
): Promise<string> {
  // Transfer Futures → Spot first
  const futuresBalances = await binance.getBalance();
  const futuresUsdc = futuresBalances.find((b) => b.asset === 'USDC');
  const futuresAvailable = futuresUsdc ? parseFloat(futuresUsdc.availableBalance) : 0;
  if (futuresAvailable > 0) {
    log(`Transferring ${futuresAvailable.toFixed(2)} USDC from Futures to Spot...`);
    await binance.transferFuturesToSpot('USDC', futuresAvailable.toFixed(2));
    log('✅ Futures → Spot transfer done');
    await sleep(2000, 'Waiting for balance to settle');
  }

  // Get Spot available balance via deposit history workaround — use futures balance
  const balances = await binance.getBalance();
  const usdc = balances.find((b) => b.asset === 'USDC');
  // After transferring to spot, futures balance should be ~0, use the transferred amount
  const available = futuresAvailable;

  if (available < 1) {
    throw new Error(`Insufficient available USDC: ${available.toFixed(2)}`);
  }

  // Withdraw slightly less to account for any rounding
  const withdrawAmount = Math.floor(available * 100) / 100;

  log(`Withdrawing ${withdrawAmount} USDC to ${walletAddress.slice(0, 8)}... (Solana network)`);

  const ok = await confirm(`Withdraw ${withdrawAmount} USDC from Binance to your Solana wallet?`);
  if (!ok) throw new Error('Cancelled by user');

  const result = await binance.withdraw(
    'USDC',
    walletAddress,
    withdrawAmount.toString(),
    'SOL',
  );
  log(`✅ Withdrawal submitted: id=${result.id}`);
  log('   Note: Binance withdrawals typically take 5-30 minutes');
  return result.id;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Binance Flow Test (少額テスト)');
  console.log('═══════════════════════════════════════════');
  console.log(`  Step:     ${step}`);
  console.log(`  Amount:   ${depositAmount} USDC`);
  console.log(`  Short:    ${shortSol} SOL`);
  console.log(`  Symbol:   ${SYMBOL}`);
  console.log('');

  const { binance, txSender, wallet } = initClients();
  const walletAddress = process.env.SOLANA_WALLET_ADDRESS || wallet.publicKey;
  console.log(`  Wallet:   ${walletAddress.slice(0, 8)}...${walletAddress.slice(-4)}`);

  // Always show status first
  await showStatus(binance);

  if (step === 'status') return;

  // ── Full flow or individual steps ──

  if (step === 'all' || step === 'deposit') {
    console.log('\n── Step 1: Deposit USDC to Binance ──');
    await stepDeposit(txSender, binance, depositAmount);

    console.log('\n── Step 1b: Wait for Binance deposit ──');
    const deposited = await waitDeposit(binance, depositAmount);
    if (!deposited && step === 'all') {
      log('⚠️  Deposit not confirmed. Run with --step short once it arrives.');
      return;
    }
    console.log('\n── Step 1c: Transfer Spot → Futures ──');
    await stepSpotToFutures(binance, depositAmount);
    await showStatus(binance);
  }

  if (step === 'all' || step === 'short') {
    console.log('\n── Step 2: Open perp short ──');
    await stepOpenShort(binance, shortSol);
    await showStatus(binance);
  }

  if (step === 'all' || step === 'close') {
    console.log('\n── Step 3: Close perp short ──');
    await stepCloseShort(binance);
    await showStatus(binance);
  }

  if (step === 'all' || step === 'withdraw') {
    console.log('\n── Step 4: Withdraw USDC from Binance ──');
    await stepWithdraw(binance, walletAddress);
  }

  console.log('\n✅ Test complete');
}

main().catch((err) => {
  console.error(`\n❌ Error: ${(err as Error).message}`);
  process.exit(1);
});
