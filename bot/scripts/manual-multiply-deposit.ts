/**
 * Manual Multiply: deposit 49 USDC into ONyc/USDC position via loop.
 * Tx1: USDC → ONyc (Jupiter swap)
 * Tx2: deposit ONyc (KaminoAction)
 * Tx3: borrow USDC (KaminoAction)
 * Repeat until target leverage reached.
 *
 * Run: npx tsx scripts/manual-multiply-deposit.ts
 */
import 'dotenv/config';
import {
  KaminoMarket,
  KaminoAction,
  MultiplyObligation,
  DEFAULT_RECENT_SLOT_DURATION_MS,
  PROGRAM_ID,
} from '@kamino-finance/klend-sdk';
import {
  address,
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
} from '@solana/kit';
import {
  Connection, Keypair, VersionedTransaction, PublicKey,
} from '@solana/web3.js';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';

const MARKET_ADDRESS = '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8';
const ONYC_MINT = '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const DEPOSIT_USDC = 49;
const TARGET_HEALTH = 1.15;
const MAX_LTV = 0.60; // conservative: use 60% of max LTV per loop
const MAX_LOOPS = 4;

async function jupiterSwap(
  conn: Connection,
  keypair: InstanceType<typeof Keypair>,
  inputMint: string,
  outputMint: string,
  amountBaseUnits: number,
): Promise<{ outputAmount: number; sig: string }> {
  const params = new URLSearchParams({
    inputMint, outputMint,
    amount: Math.floor(amountBaseUnits).toString(),
    slippageBps: '50',
  });
  const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?${params}`, {
    headers: { 'x-api-key': process.env.JUPITER_API_KEY! },
  });
  if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.status}`);
  const quote = (await quoteRes.json()) as any;

  const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.JUPITER_API_KEY! },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapRes.ok) throw new Error(`Swap failed: ${swapRes.status}`);
  const swapData = (await swapRes.json()) as any;

  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
  tx.sign([keypair]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });

  const outDecimals = outputMint === ONYC_MINT ? 9 : 6;
  const outputAmount = Number(quote.outAmount) / Math.pow(10, outDecimals);
  return { outputAmount, sig };
}

async function sendKaminoTx(
  rpc: any,
  signer: any,
  kaminoAction: { setupIxs: any[]; lendingIxs: any[]; cleanupIxs: any[] },
): Promise<string> {
  const allIxs = [...kaminoAction.setupIxs, ...kaminoAction.lendingIxs, ...kaminoAction.cleanupIxs];
  if (allIxs.length === 0) throw new Error('No instructions');

  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(signer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
    (msg) => appendTransactionMessageInstructions(allIxs, msg),
  );
  const signedTx = await signTransactionMessageWithSigners(txMessage);
  const base64Tx = getBase64EncodedWireTransaction(signedTx);
  return rpc.sendTransaction(base64Tx, {
    encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: BigInt(3),
  }).send();
}

async function getOnycBalance(conn: Connection, wallet: PublicKey): Promise<number> {
  const tokens = await conn.getParsedTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM });
  const onyc = tokens.value.find(t => t.account.data.parsed.info.mint === ONYC_MINT);
  return onyc ? parseFloat(onyc.account.data.parsed.info.tokenAmount.uiAmountString) : 0;
}

async function getUsdcBalance(conn: Connection, wallet: PublicKey): Promise<number> {
  const tokens = await conn.getParsedTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM });
  const usdc = tokens.value.find(t => t.account.data.parsed.info.mint === USDC_MINT);
  return usdc ? parseFloat(usdc.account.data.parsed.info.tokenAmount.uiAmountString) : 0;
}

async function main() {
  const rpcUrl = process.env.HELIUS_RPC_URL!;
  const wallet = loadWalletFromEnv();
  const conn = new Connection(rpcUrl, 'confirmed');
  const keypair = Keypair.fromSecretKey(wallet.secretKey);
  const rpc = createSolanaRpc(rpcUrl as any);
  const signer = await createKeyPairSignerFromBytes(wallet.secretKey);

  console.log('=== Manual ONyc/USDC Multiply Deposit ===');
  console.log(`Wallet:  ${keypair.publicKey.toBase58()}`);
  console.log(`Amount:  ${DEPOSIT_USDC} USDC`);
  console.log(`Target:  health >= ${TARGET_HEALTH}`);
  console.log('');

  const market = await KaminoMarket.load(rpc, address(MARKET_ADDRESS), DEFAULT_RECENT_SLOT_DURATION_MS);
  if (!market) throw new Error('Failed to load market');

  const obligationType = new MultiplyObligation(address(ONYC_MINT), address(USDC_MINT), PROGRAM_ID);
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  // ── Initial swap: USDC → ONyc ──
  console.log('--- Initial: USDC → ONyc swap ---');
  const usdcBalance = await getUsdcBalance(conn, keypair.publicKey);
  const swapAmount = Math.min(DEPOSIT_USDC, usdcBalance);
  console.log(`  USDC available: ${usdcBalance.toFixed(2)}`);

  const { outputAmount: initialOnyc, sig: swapSig } = await jupiterSwap(
    conn, keypair, USDC_MINT, ONYC_MINT, swapAmount * 1e6,
  );
  console.log(`  Swapped ${swapAmount} USDC → ${initialOnyc.toFixed(4)} ONyc`);
  console.log(`  Tx: ${swapSig}`);
  await wait(2000);

  // ── Initial deposit: ONyc as collateral ──
  console.log('\n--- Initial: Deposit ONyc ---');
  await market.loadReserves();
  const onycToDeposit = await getOnycBalance(conn, keypair.publicKey);
  const depositBase = Math.floor(onycToDeposit * 1e9).toString();

  const depositAction = await KaminoAction.buildDepositTxns(
    market, depositBase, address(ONYC_MINT), signer,
    obligationType, false, undefined,
  );
  const depositSig = await sendKaminoTx(rpc, signer, depositAction);
  console.log(`  Deposited ${onycToDeposit.toFixed(4)} ONyc`);
  console.log(`  Tx: ${depositSig}`);
  await wait(2000);

  // ── Leverage loops ──
  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    console.log(`\n--- Loop ${loop + 1} ---`);

    // Check health
    await market.loadReserves();
    const obl = await market.getObligationByWallet(signer.address, obligationType);
    if (obl) {
      const stats = obl.refreshedStats;
      const deposited = stats.userTotalDeposit.toNumber();
      const borrowed = stats.userTotalBorrow.toNumber();
      const health = borrowed > 0 ? stats.borrowLiquidationLimit.div(stats.userTotalBorrow).toNumber() : Infinity;
      console.log(`  Position: deposited=$${deposited.toFixed(2)} borrowed=$${borrowed.toFixed(2)} health=${health === Infinity ? 'N/A' : health.toFixed(4)}`);

      // Stop if we've reached enough leverage
      if (health !== Infinity && health <= TARGET_HEALTH * 1.02) {
        console.log(`  Health ${health.toFixed(4)} near target ${TARGET_HEALTH}, stopping`);
        break;
      }

      // Calculate safe borrow amount (LTV-based)
      const maxBorrow = deposited * MAX_LTV - borrowed;
      if (maxBorrow < 1) {
        console.log('  Max borrow too small, stopping');
        break;
      }

      // Borrow USDC
      console.log(`  Borrowing $${maxBorrow.toFixed(2)} USDC...`);
      await market.loadReserves();

      const slotResult = await rpc.getSlot({ commitment: 'confirmed' }).send();
      const currentSlot = typeof slotResult === 'object' ? (slotResult as any).value ?? slotResult : slotResult;

      const borrowBase = Math.floor(maxBorrow * 1e6).toString();
      const borrowAction = await KaminoAction.buildBorrowTxns(
        market, borrowBase, address(USDC_MINT), signer,
        obligationType, false, undefined,
      );
      const borrowSig = await sendKaminoTx(rpc, signer, borrowAction);
      console.log(`  Borrowed: Tx ${borrowSig}`);
      await wait(2000);

      // Swap borrowed USDC → ONyc
      const borrowedUsdc = await getUsdcBalance(conn, keypair.publicKey);
      if (borrowedUsdc < 0.5) {
        console.log('  Not enough USDC to swap, stopping');
        break;
      }
      console.log(`  Swapping ${borrowedUsdc.toFixed(2)} USDC → ONyc...`);
      const { outputAmount: loopOnyc, sig: loopSwapSig } = await jupiterSwap(
        conn, keypair, USDC_MINT, ONYC_MINT, borrowedUsdc * 1e6,
      );
      console.log(`  Got ${loopOnyc.toFixed(4)} ONyc, Tx: ${loopSwapSig}`);
      await wait(2000);

      // Re-deposit ONyc
      const reDepositOnyc = await getOnycBalance(conn, keypair.publicKey);
      if (reDepositOnyc < 0.001) {
        console.log('  No ONyc to deposit, stopping');
        break;
      }
      await market.loadReserves();
      const reDepositBase = Math.floor(reDepositOnyc * 1e9).toString();
      const reDepositAction = await KaminoAction.buildDepositTxns(
        market, reDepositBase, address(ONYC_MINT), signer,
        obligationType, false, undefined,
      );
      const reDepositSig = await sendKaminoTx(rpc, signer, reDepositAction);
      console.log(`  Re-deposited ${reDepositOnyc.toFixed(4)} ONyc, Tx: ${reDepositSig}`);
      await wait(2000);
    } else {
      console.log('  No obligation found!');
      break;
    }
  }

  // ── Final status ──
  console.log('\n=== Final Position ===');
  await market.loadReserves();
  const finalObl = await market.getObligationByWallet(signer.address, obligationType);
  if (finalObl) {
    const stats = finalObl.refreshedStats;
    const deposited = stats.userTotalDeposit.toNumber();
    const borrowed = stats.userTotalBorrow.toNumber();
    const health = borrowed > 0 ? stats.borrowLiquidationLimit.div(stats.userTotalBorrow).toNumber() : Infinity;
    const leverage = borrowed > 0 ? deposited / (deposited - borrowed) : 1;

    console.log(`Deposited:  $${deposited.toFixed(2)}`);
    console.log(`Borrowed:   $${borrowed.toFixed(2)}`);
    console.log(`Net Equity: $${(deposited - borrowed).toFixed(2)}`);
    console.log(`Health:     ${health === Infinity ? 'N/A' : health.toFixed(4)}`);
    console.log(`Leverage:   ${leverage.toFixed(2)}x`);
  }

  console.log('\nDone.');
}

main().catch(console.error);
