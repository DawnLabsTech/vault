#!/usr/bin/env tsx
/**
 * Withdraw USDC from Drift Protocol.
 *
 * Usage:
 *   npx tsx scripts/drift-withdraw.ts              # Check balance & withdraw all
 *   npx tsx scripts/drift-withdraw.ts --check-only  # Balance check only
 *   npx tsx scripts/drift-withdraw.ts --amount 5    # Withdraw specific amount
 */
import 'dotenv/config';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';
import { DriftPerp } from '../src/connectors/drift/perp.js';

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check-only');
  const amountIdx = args.indexOf('--amount');
  const specifiedAmount = amountIdx >= 0 ? parseFloat(args[amountIdx + 1]!) : undefined;

  const wallet = loadWalletFromEnv();
  const walletAddress = process.env.SOLANA_WALLET_ADDRESS || wallet.publicKey;
  const rpcUrl = process.env.HELIUS_RPC_URL || '';
  const network = (process.env.DRIFT_NETWORK as 'mainnet-beta' | 'devnet') || 'mainnet-beta';

  console.log(`Wallet: ${walletAddress}`);

  const drift = new DriftPerp(rpcUrl, wallet.secretKey, walletAddress, network);

  try {
    const balance = await drift.getUsdcBalance();
    const position = await drift.getPosition();
    console.log(`Drift USDC balance: ${balance.toFixed(6)}`);
    console.log(`Open position size: ${position.size}`);
    console.log(`Unrealized PnL: ${position.unrealizedPnl}`);

    if (checkOnly) return;

    if (balance < 0.01) {
      console.log('No USDC to withdraw.');
      return;
    }

    const withdrawAmount = specifiedAmount
      ? Math.min(specifiedAmount, balance)
      : Math.floor(balance * 100) / 100;

    console.log(`\nWithdrawing ${withdrawAmount} USDC from Drift...`);
    const txSig = await drift.withdrawMargin(withdrawAmount);
    console.log(`TX: ${txSig}`);
    console.log(`https://solscan.io/tx/${txSig}`);

    const newBalance = await drift.getUsdcBalance();
    console.log(`\nNew Drift USDC balance: ${newBalance.toFixed(6)}`);
  } finally {
    await drift.cleanup();
  }
}

main().catch((err) => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});
