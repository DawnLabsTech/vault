#!/usr/bin/env tsx
/**
 * Binance Spot → Solana wallet → Drift margin deposit
 *
 * Usage:
 *   npx tsx scripts/binance-to-drift.ts                  # Default: withdraw 16 USDC, deposit 10 to Drift
 *   npx tsx scripts/binance-to-drift.ts --withdraw-only  # Only withdraw from Binance
 *   npx tsx scripts/binance-to-drift.ts --deposit-only   # Only deposit to Drift (USDC already in wallet)
 */
import 'dotenv/config';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';
import { BinanceRestClient } from '../src/connectors/binance/rest.js';
import { DriftPerp } from '../src/connectors/drift/perp.js';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const BINANCE_WITHDRAW_AMOUNT = '16';  // USDC to withdraw from Binance
const DRIFT_DEPOSIT_AMOUNT = 10;       // USDC to deposit to Drift margin

async function getUsdcBalance(connection: Connection, walletAddress: string): Promise<number> {
  try {
    const pubkey = new PublicKey(walletAddress);
    const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, pubkey);
    const tokenAccount = await connection.getTokenAccountBalance(usdcAta);
    return tokenAccount.value.uiAmount ?? 0;
  } catch {
    return 0;
  }
}

async function withdrawFromBinance(walletAddress: string): Promise<string> {
  console.log(`\n=== Binance Spot → Wallet (${BINANCE_WITHDRAW_AMOUNT} USDC) ===`);

  const apiKey = process.env.BINANCE_API_KEY || '';
  const apiSecret = process.env.BINANCE_API_SECRET || '';
  if (!apiKey || !apiSecret) {
    throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET not set');
  }

  const client = new BinanceRestClient(apiKey, apiSecret, false);

  const result = await client.withdraw('USDC', walletAddress, BINANCE_WITHDRAW_AMOUNT, 'SOL');
  console.log(`  ✅ Withdrawal submitted: id=${result.id}`);
  return result.id;
}

async function waitForDeposit(
  connection: Connection,
  walletAddress: string,
  initialBalance: number,
  timeoutMs = 300_000,
): Promise<boolean> {
  console.log(`\n  ⏳ Waiting for USDC to arrive (initial: ${initialBalance.toFixed(2)})...`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 15_000));
    const balance = await getUsdcBalance(connection, walletAddress);
    console.log(`  ... USDC balance: ${balance.toFixed(2)}`);
    if (balance > initialBalance + 1) {
      console.log(`  ✅ Deposit received! Balance: ${balance.toFixed(2)}`);
      return true;
    }
  }
  console.log('  ❌ Timeout waiting for deposit');
  return false;
}

async function depositToDrift(
  walletAddress: string,
  rpcUrl: string,
  secretKey: Uint8Array,
  amount: number,
): Promise<string> {
  console.log(`\n=== Drift Margin Deposit (${amount} USDC) ===`);

  const network = (process.env.DRIFT_NETWORK as 'mainnet-beta' | 'devnet') || 'mainnet-beta';
  const drift = new DriftPerp(rpcUrl, secretKey, walletAddress, network);

  try {
    const txSig = await drift.depositMargin(amount);
    console.log(`  ✅ Deposit TX: ${txSig}`);
    console.log(`  https://solscan.io/tx/${txSig}`);

    // Verify balance
    const balance = await drift.getUsdcBalance();
    console.log(`  Drift USDC balance: ${balance.toFixed(2)}`);

    return txSig;
  } finally {
    await drift.cleanup();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const withdrawOnly = args.includes('--withdraw-only');
  const depositOnly = args.includes('--deposit-only');

  const wallet = loadWalletFromEnv();
  const walletAddress = process.env.SOLANA_WALLET_ADDRESS || wallet.publicKey;
  const rpcUrl = process.env.HELIUS_RPC_URL || '';
  const connection = new Connection(rpcUrl, 'confirmed');

  console.log('🔄 Binance → Drift Margin Transfer');
  console.log(`  Wallet: ${walletAddress}`);

  // Show initial balances
  const solBalance = await connection.getBalance(new PublicKey(walletAddress));
  const usdcBalance = await getUsdcBalance(connection, walletAddress);
  console.log(`  SOL: ${solBalance / LAMPORTS_PER_SOL}`);
  console.log(`  USDC: ${usdcBalance.toFixed(2)}`);

  // Step 1: Withdraw from Binance
  if (!depositOnly) {
    await withdrawFromBinance(walletAddress);
    const arrived = await waitForDeposit(connection, walletAddress, usdcBalance);
    if (!arrived) {
      console.log('\n⚠️  Deposit not yet confirmed. Run again with --deposit-only once it arrives.');
      process.exit(1);
    }
  }

  // Step 2: Deposit to Drift
  if (!withdrawOnly) {
    const currentUsdc = await getUsdcBalance(connection, walletAddress);
    if (currentUsdc < DRIFT_DEPOSIT_AMOUNT) {
      console.log(`\n❌ Insufficient USDC for Drift deposit: ${currentUsdc.toFixed(2)} < ${DRIFT_DEPOSIT_AMOUNT}`);
      process.exit(1);
    }
    await depositToDrift(walletAddress, rpcUrl, wallet.secretKey, DRIFT_DEPOSIT_AMOUNT);
  }

  // Final balances
  const finalUsdc = await getUsdcBalance(connection, walletAddress);
  console.log(`\n✅ Complete! Wallet USDC: ${finalUsdc.toFixed(2)}`);
}

main().catch((err) => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
