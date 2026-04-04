#!/usr/bin/env tsx
/**
 * Swap a small amount of USDC → SOL via Jupiter public API to top up SOL for gas.
 *
 * Usage:
 *   npx tsx scripts/swap-usdc-to-sol.ts          # Default: swap 1 USDC
 *   npx tsx scripts/swap-usdc-to-sol.ts 0.5      # Swap 0.5 USDC
 */
import 'dotenv/config';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';
import { SolanaTransactionSender } from '../src/connectors/solana/tx-sender.js';

const JUPITER_PUBLIC_API = 'https://public.jupiterapi.com';
const USDC_MINT_STR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT_STR = 'So11111111111111111111111111111111111111112';
const USDC_MINT = new PublicKey(USDC_MINT_STR);

async function main() {
  const usdcAmount = parseFloat(process.argv[2] || '1');

  const wallet = loadWalletFromEnv();
  const walletAddress = process.env.SOLANA_WALLET_ADDRESS || wallet.publicKey;
  const rpcUrl = process.env.HELIUS_RPC_URL || '';
  const connection = new Connection(rpcUrl, 'confirmed');
  const pubkey = new PublicKey(walletAddress);

  // Before balances
  const solBefore = await connection.getBalance(pubkey);
  const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, pubkey);
  const usdcAccount = await connection.getTokenAccountBalance(usdcAta);
  const usdcBefore = usdcAccount.value.uiAmount ?? 0;

  console.log(`🔄 Swap ${usdcAmount} USDC → SOL`);
  console.log(`  Before: SOL=${(solBefore / LAMPORTS_PER_SOL).toFixed(6)}, USDC=${usdcBefore.toFixed(2)}`);

  // Get quote from Jupiter public API
  const baseUnits = Math.floor(usdcAmount * 1e6);
  const quoteParams = new URLSearchParams({
    inputMint: USDC_MINT_STR,
    outputMint: SOL_MINT_STR,
    amount: baseUnits.toString(),
    slippageBps: '100',
  });

  const quoteRes = await fetch(`${JUPITER_PUBLIC_API}/quote?${quoteParams}`);
  if (!quoteRes.ok) {
    throw new Error(`Jupiter quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  }
  const quoteData = await quoteRes.json() as any;

  const expectedSol = Number(quoteData.outAmount) / 1e9;
  console.log(`  Quote: ${usdcAmount} USDC → ${expectedSol.toFixed(6)} SOL`);

  // Get swap transaction
  const swapRes = await fetch(`${JUPITER_PUBLIC_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quoteData,
      userPublicKey: walletAddress,
      wrapAndUnwrapSol: true,
    }),
  });

  if (!swapRes.ok) {
    throw new Error(`Jupiter swap failed: ${swapRes.status} ${await swapRes.text()}`);
  }
  const swapData = await swapRes.json() as any;

  // Execute swap
  const txSender = new SolanaTransactionSender(rpcUrl, wallet.secretKey);
  const txSig = await txSender.signAndSendBase64(swapData.swapTransaction);
  console.log(`  TX: ${txSig}`);
  console.log(`  https://solscan.io/tx/${txSig}`);

  const confirmed = await txSender.confirm(txSig);
  if (!confirmed) {
    console.log('  ❌ Transaction failed to confirm');
    process.exit(1);
  }

  // After balances
  const solAfter = await connection.getBalance(pubkey);
  console.log(`\n✅ Swap complete!`);
  console.log(`  SOL: ${(solBefore / LAMPORTS_PER_SOL).toFixed(6)} → ${(solAfter / LAMPORTS_PER_SOL).toFixed(6)}`);
}

main().catch((err) => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
