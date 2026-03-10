#!/usr/bin/env tsx
/**
 * Pre-flight check script for M7 (少額本番) readiness.
 *
 * Usage:
 *   npx tsx scripts/preflight-check.ts              # Read-only checks (balance + APY)
 *   npx tsx scripts/preflight-check.ts --deposit     # Deposit 1 USDC to Kamino
 *   npx tsx scripts/preflight-check.ts --withdraw    # Withdraw 1 USDC from Kamino
 *   npx tsx scripts/preflight-check.ts --full-cycle  # Deposit → wait → Withdraw
 */
import 'dotenv/config';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';
import { KaminoLending } from '../src/connectors/defi/kamino.js';
import { DriftLending } from '../src/connectors/defi/drift.js';
import { JupiterLending } from '../src/connectors/defi/jupiter-lend.js';
import { BinanceRestClient } from '../src/connectors/binance/rest.js';
import { sendAlert } from '../src/utils/notify.js';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TEST_DEPOSIT_AMOUNT = 1; // 1 USDC

async function checkWalletBalance(connection: Connection, walletAddress: string) {
  console.log('\n=== Wallet Balance ===');
  const pubkey = new PublicKey(walletAddress);

  // SOL balance
  const solBalance = await connection.getBalance(pubkey);
  console.log(`  SOL: ${solBalance / LAMPORTS_PER_SOL}`);

  // USDC balance
  try {
    const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, pubkey);
    const tokenAccount = await connection.getTokenAccountBalance(usdcAta);
    console.log(`  USDC: ${tokenAccount.value.uiAmount}`);
  } catch {
    console.log('  USDC: 0 (no token account)');
  }
}

async function checkLendingApys(walletAddress: string, rpcUrl: string, secretKey: Uint8Array) {
  console.log('\n=== Lending APYs ===');

  const protocols = [
    new KaminoLending(walletAddress, rpcUrl, secretKey),
    new DriftLending(walletAddress, rpcUrl, secretKey),
    new JupiterLending(walletAddress, rpcUrl, secretKey),
  ];

  for (const p of protocols) {
    try {
      const apy = await p.getApy();
      const balance = await p.getBalance();
      console.log(`  ${p.name}: APY=${(apy * 100).toFixed(2)}%, Balance=${balance.toFixed(2)} USDC`);
    } catch (err) {
      console.log(`  ${p.name}: ERROR - ${(err as Error).message}`);
    }
  }
}

async function testDeposit(walletAddress: string, rpcUrl: string, secretKey: Uint8Array) {
  console.log(`\n=== Kamino Deposit ${TEST_DEPOSIT_AMOUNT} USDC ===`);
  const kamino = new KaminoLending(walletAddress, rpcUrl, secretKey);

  try {
    const sig = await kamino.deposit(TEST_DEPOSIT_AMOUNT);
    console.log(`  ✅ Deposit TX: ${sig}`);
    console.log(`  https://solscan.io/tx/${sig}`);
    return true;
  } catch (err) {
    console.log(`  ❌ Deposit failed: ${(err as Error).message}`);
    return false;
  }
}

async function testWithdraw(walletAddress: string, rpcUrl: string, secretKey: Uint8Array) {
  console.log(`\n=== Kamino Withdraw ${TEST_DEPOSIT_AMOUNT} USDC ===`);
  const kamino = new KaminoLending(walletAddress, rpcUrl, secretKey);

  try {
    const sig = await kamino.withdraw(TEST_DEPOSIT_AMOUNT);
    console.log(`  ✅ Withdraw TX: ${sig}`);
    console.log(`  https://solscan.io/tx/${sig}`);
    return true;
  } catch (err) {
    console.log(`  ❌ Withdraw failed: ${(err as Error).message}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const doDeposit = args.includes('--deposit') || args.includes('--full-cycle');
  const doWithdraw = args.includes('--withdraw') || args.includes('--full-cycle');
  const fullCycle = args.includes('--full-cycle');

  console.log('🔍 Vault Pre-flight Check');
  console.log('========================');

  // Load wallet
  const wallet = loadWalletFromEnv();
  const walletAddress = process.env.SOLANA_WALLET_ADDRESS || wallet.publicKey;
  const rpcUrl = process.env.HELIUS_RPC_URL || '';
  console.log(`  Wallet: ${walletAddress}`);
  console.log(`  RPC: ${rpcUrl.replace(/api-key=.*/, 'api-key=***')}`);

  const connection = new Connection(rpcUrl, 'confirmed');

  // 1. Wallet balance
  await checkWalletBalance(connection, walletAddress);

  // 2. Lending APYs + balances
  await checkLendingApys(walletAddress, rpcUrl, wallet.secretKey);

  // 3. Optional deposit test
  if (doDeposit) {
    const ok = await testDeposit(walletAddress, rpcUrl, wallet.secretKey);
    if (!ok) process.exit(1);

    if (fullCycle) {
      console.log('\n  ⏳ Waiting 10s for TX confirmation...');
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  // 4. Optional withdraw test
  if (doWithdraw) {
    const ok = await testWithdraw(walletAddress, rpcUrl, wallet.secretKey);
    if (!ok) process.exit(1);
  }

  // 5. Final balance check
  if (doDeposit || doWithdraw) {
    console.log('\n  ⏳ Waiting 5s for final balance update...');
    await new Promise((r) => setTimeout(r, 5_000));
    await checkWalletBalance(connection, walletAddress);
    await checkLendingApys(walletAddress, rpcUrl, wallet.secretKey);
  }

  // 6. Binance API check
  await checkBinance();

  // 7. Telegram notification check
  await checkTelegram();

  console.log('\n✅ Pre-flight check complete');
}

async function checkBinance() {
  console.log('\n=== Binance API ===');
  const apiKey = process.env.BINANCE_API_KEY || '';
  const apiSecret = process.env.BINANCE_API_SECRET || '';

  if (!apiKey || !apiSecret) {
    console.log('  ⚠️  BINANCE_API_KEY / BINANCE_API_SECRET not set');
    return;
  }

  const client = new BinanceRestClient(apiKey, apiSecret, false);

  // Funding rate
  try {
    const fr = await client.getCurrentFundingRate('SOLUSDC');
    const rate = parseFloat(fr.lastFundingRate);
    const annualized = rate * 3 * 365 * 100;
    console.log(`  FR (SOLUSDC): ${(rate * 100).toFixed(4)}% (annualized ${annualized.toFixed(1)}%)`);
    console.log(`  Mark Price: $${parseFloat(fr.markPrice).toFixed(2)}`);
  } catch (err) {
    console.log(`  ❌ FR fetch failed: ${(err as Error).message}`);
  }

  // Balance
  try {
    const balances = await client.getBalance();
    const usdt = balances.find((b) => b.asset === 'USDT');
    const usdc = balances.find((b) => b.asset === 'USDC');
    console.log(`  Futures USDT: ${usdt ? parseFloat(usdt.balance).toFixed(2) : '0.00'}`);
    console.log(`  Futures USDC: ${usdc ? parseFloat(usdc.balance).toFixed(2) : '0.00'}`);
  } catch (err) {
    console.log(`  ❌ Balance fetch failed: ${(err as Error).message}`);
  }

  // Position
  try {
    const positions = await client.getPosition('SOLUSDC');
    const active = positions.filter((p) => parseFloat(p.positionAmt) !== 0);
    if (active.length === 0) {
      console.log('  Positions: none (clean)');
    } else {
      for (const p of active) {
        console.log(`  Position: ${p.positionAmt} SOL @ $${parseFloat(p.entryPrice).toFixed(2)}, PnL: $${parseFloat(p.unRealizedProfit).toFixed(2)}`);
      }
    }
  } catch (err) {
    console.log(`  ❌ Position fetch failed: ${(err as Error).message}`);
  }
}

async function checkTelegram() {
  console.log('\n=== Telegram ===');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('  ⚠️  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set');
    return;
  }

  try {
    await sendAlert('Pre-flight check: Telegram notification test', 'info');
    console.log('  ✅ Test message sent');
  } catch (err) {
    console.log(`  ❌ Send failed: ${(err as Error).message}`);
  }
}

main().catch((err) => {
  console.error('❌ Pre-flight check failed:', err);
  process.exit(1);
});
