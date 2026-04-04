/**
 * Swap all ONyc back to USDC.
 * Run: npx tsx scripts/swap-onyc-to-usdc.ts
 */
import 'dotenv/config';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';

const ONYC_MINT = '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

async function main() {
  const wallet = loadWalletFromEnv();
  const conn = new Connection(process.env.HELIUS_RPC_URL!, 'confirmed');
  const keypair = Keypair.fromSecretKey(wallet.secretKey);

  // Find ONyc balance
  const tokens = await conn.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: TOKEN_PROGRAM });
  const onycAccount = tokens.value.find(t => t.account.data.parsed.info.mint === ONYC_MINT);
  if (!onycAccount) { console.log('No ONyc in wallet'); return; }

  const onycAmount = onycAccount.account.data.parsed.info.tokenAmount.amount;
  const onycHuman = onycAccount.account.data.parsed.info.tokenAmount.uiAmountString;
  console.log(`ONyc balance: ${onycHuman}`);

  // Quote
  const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?` + new URLSearchParams({
    inputMint: ONYC_MINT, outputMint: USDC_MINT, amount: onycAmount, slippageBps: '50',
  }), { headers: { 'x-api-key': process.env.JUPITER_API_KEY! } });
  const quote = (await quoteRes.json()) as any;
  console.log(`Expected USDC: ${(Number(quote.outAmount) / 1e6).toFixed(2)}`);

  // Swap
  const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.JUPITER_API_KEY! },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    }),
  });
  const swapData = (await swapRes.json()) as any;
  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
  tx.sign([keypair]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
  console.log(`Swap tx: ${sig}`);

  await new Promise(r => setTimeout(r, 3000));

  // Verify
  const tokens2 = await conn.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: TOKEN_PROGRAM });
  console.log('\nPost-swap balances:');
  for (const t of tokens2.value) {
    const info = t.account.data.parsed.info;
    if (parseFloat(info.tokenAmount.uiAmountString) > 0) {
      console.log(`  ${info.mint.slice(0, 12)}... ${info.tokenAmount.uiAmountString}`);
    }
  }
}

main().catch(console.error);
