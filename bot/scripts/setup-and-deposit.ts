/**
 * Full SDK flow: Setup Account + Deposit USDC into ONyc/USDC Multiply.
 *
 * Step 1: createLookupTable + initUserMetadata + initObligation (if needed)
 * Step 2: Deposit with leverage (selectedTokenMint=USDC)
 *
 * Run: npx tsx scripts/setup-and-deposit.ts
 */
import 'dotenv/config';
import {
  KaminoMarket,
  MultiplyObligation,
  ObligationTypeTag,
  DEFAULT_RECENT_SLOT_DURATION_MS,
  PROGRAM_ID,
  getDepositWithLeverageIxs,
} from '@kamino-finance/klend-sdk';
import { createLookupTableIx } from '@kamino-finance/klend-sdk/dist/utils/lookupTable.js';
import { userMetadataPda } from '@kamino-finance/klend-sdk/dist/utils/seeds.js';
import { initUserMetadata } from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/initUserMetadata.js';
import { initObligation } from '@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/initObligation.js';
import {
  address,
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  none,
  type Instruction,
} from '@solana/kit';
import {
  Connection, Keypair, VersionedTransaction, TransactionMessage,
  PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import Decimal from 'decimal.js';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';
import { deserializeInstruction } from '../src/connectors/defi/jupiter-ix-utils.js';

const MARKET_ADDRESS = '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8';
const ONYC_MINT = '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const KLEND_PROGRAM = PROGRAM_ID;
const DEPOSIT_USDC = 49;

function kitIxToWeb3(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress as string),
    keys: ((ix as any).accounts ?? []).map((acc: any) => ({
      pubkey: new PublicKey(acc.address as string),
      isSigner: acc.role === 2 || acc.role === 3,
      isWritable: acc.role === 1 || acc.role === 3,
    })),
    data: Buffer.from(ix.data as Uint8Array),
  });
}

async function sendWeb3Tx(
  conn: Connection,
  keypair: InstanceType<typeof Keypair>,
  ixs: TransactionInstruction[],
  alts: any[] = [],
): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);
  console.log(`  Tx size: ${tx.serialize().length} bytes`);
  const sig = await conn.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });
  return sig;
}

async function main() {
  const rpcUrl = process.env.HELIUS_RPC_URL!;
  const wallet = loadWalletFromEnv();
  const conn = new Connection(rpcUrl, 'confirmed');
  const keypair = Keypair.fromSecretKey(wallet.secretKey);
  const rpc = createSolanaRpc(rpcUrl as any);
  const signer = await createKeyPairSignerFromBytes(wallet.secretKey);

  console.log('=== ONyc/USDC Multiply: Full SDK Setup & Deposit ===');
  console.log(`Wallet:  ${keypair.publicKey.toBase58()}`);
  console.log(`Deposit: ${DEPOSIT_USDC} USDC`);
  console.log('');

  // Load market
  const market = await KaminoMarket.load(rpc, address(MARKET_ADDRESS), DEFAULT_RECENT_SLOT_DURATION_MS);
  if (!market) throw new Error('Failed to load market');
  await market.loadReserves();
  console.log('Market loaded');

  const obligationType = new MultiplyObligation(address(ONYC_MINT), address(USDC_MINT), KLEND_PROGRAM);

  // ── Step 1: Check and create UserMetadata ──
  console.log('\n--- Step 1: UserMetadata ---');
  const [userMetadataAddr] = await userMetadataPda(signer.address, KLEND_PROGRAM);
  const userMetadataInfo = await conn.getAccountInfo(new PublicKey(userMetadataAddr as string));

  if (userMetadataInfo && userMetadataInfo.owner.toBase58() === (KLEND_PROGRAM as string)) {
    console.log('UserMetadata exists, skipping');
  } else {
    console.log('Creating LookupTable + UserMetadata...');

    // Create lookup table
    const [createLutIx, lutAddress] = await createLookupTableIx(rpc, signer);
    console.log(`  LUT address: ${lutAddress}`);

    // Init user metadata
    const initMetadataIx = initUserMetadata(
      { userLookupTable: lutAddress },
      {
        owner: signer,
        feePayer: signer,
        userMetadata: userMetadataAddr,
        referrerUserMetadata: none(),
        rent: address(SYSVAR_RENT_PUBKEY.toBase58()),
        systemProgram: address(SystemProgram.programId.toBase58()),
      },
      undefined,
      KLEND_PROGRAM,
    );

    const sig = await sendWeb3Tx(conn, keypair, [
      kitIxToWeb3(createLutIx),
      kitIxToWeb3(initMetadataIx),
    ]);
    console.log(`  Tx: ${sig}`);
    await conn.confirmTransaction(sig, 'confirmed');
    console.log('  Confirmed');
  }

  // ── Step 2: Check and create Obligation ──
  console.log('\n--- Step 2: Obligation ---');
  const existing = await market.getObligationByWallet(signer.address, obligationType);

  if (existing) {
    console.log('Obligation exists, skipping');
  } else {
    console.log('Creating Multiply obligation...');

    const obligationPda = await obligationType.toPda(address(MARKET_ADDRESS), signer.address);
    const initArgs = obligationType.toArgs();

    const initObligationIx = initObligation(
      { args: { tag: initArgs.tag, id: initArgs.id } },
      {
        obligationOwner: signer,
        feePayer: signer,
        obligation: obligationPda,
        lendingMarket: address(MARKET_ADDRESS),
        seed1Account: address(ONYC_MINT),
        seed2Account: address(USDC_MINT),
        ownerUserMetadata: userMetadataAddr,
        rent: address(SYSVAR_RENT_PUBKEY.toBase58()),
        systemProgram: address(SystemProgram.programId.toBase58()),
      },
      undefined,
      KLEND_PROGRAM,
    );

    const sig = await sendWeb3Tx(conn, keypair, [kitIxToWeb3(initObligationIx)]);
    console.log(`  Tx: ${sig}`);
    await conn.confirmTransaction(sig, 'confirmed');
    console.log('  Confirmed');
  }

  // ── Step 3: Deposit with Leverage ──
  console.log('\n--- Step 3: Deposit with Leverage ---');

  await market.loadReserves();
  const slotResult = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const slot = typeof slotResult === 'object' ? (slotResult as any).value ?? slotResult : slotResult;

  const obligation = await market.getObligationByWallet(signer.address, obligationType);
  const collReserve = market.getReserveByMint(address(ONYC_MINT));
  const debtReserve = market.getReserveByMint(address(USDC_MINT));
  if (!collReserve || !debtReserve) throw new Error('Reserves not found');

  const collPrice = collReserve.getOracleMarketPrice();
  const debtPrice = debtReserve.getOracleMarketPrice();
  const priceDebtToColl = debtPrice.div(collPrice);
  const targetLeverage = 2.4;
  const depositAmount = new Decimal(DEPOSIT_USDC).mul(1e6); // USDC base units

  console.log(`Leverage: ${targetLeverage}x`);

  const quoter = async (inputs: any) => {
    const params = new URLSearchParams({
      inputMint: inputs.inputMint,
      outputMint: inputs.outputMint,
      amount: inputs.inputAmountLamports.floor().toString(),
      slippageBps: '50',
    });
    const res = await fetch(`https://api.jup.ag/swap/v1/quote?${params}`, {
      headers: { 'x-api-key': process.env.JUPITER_API_KEY! },
    });
    if (!res.ok) throw new Error(`Quote failed: ${res.status}`);
    const data = (await res.json()) as any;
    return {
      priceAInB: new Decimal(data.outAmount).div(new Decimal(data.inAmount)),
      quoteResponse: data,
    };
  };

  const swapper = async (inputs: any, _: any[], quote: any) => {
    const swapRes = await fetch('https://api.jup.ag/swap/v1/swap-instructions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.JUPITER_API_KEY!,
      },
      body: JSON.stringify({
        quoteResponse: quote.quoteResponse,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        useSharedAccounts: true,
      }),
    });
    if (!swapRes.ok) throw new Error(`Swap-instructions failed: ${swapRes.status}`);
    const data = (await swapRes.json()) as any;

    const computeIxs = (data.computeBudgetInstructions ?? []).map(deserializeInstruction);
    const setupIxs = (data.setupInstructions ?? []).map(deserializeInstruction);
    const swapIxs = data.swapInstruction ? [deserializeInstruction(data.swapInstruction)] : [];
    const cleanupIxs = data.cleanupInstruction ? [deserializeInstruction(data.cleanupInstruction)] : [];

    const altAccounts = [];
    for (const addr of data.addressLookupTableAddresses ?? []) {
      const r = await conn.getAddressLookupTable(new PublicKey(addr));
      if (r.value) altAccounts.push(r.value);
    }

    return [{
      preActionIxs: [...computeIxs, ...setupIxs],
      swapIxs: [...swapIxs, ...cleanupIxs],
      lookupTables: altAccounts,
      quote: { priceAInB: quote.priceAInB, quoteResponse: quote.quoteResponse },
    }];
  };

  const responses = await getDepositWithLeverageIxs({
    owner: signer,
    kaminoMarket: market,
    collTokenMint: address(ONYC_MINT),
    debtTokenMint: address(USDC_MINT),
    depositAmount,
    targetLeverage: new Decimal(targetLeverage),
    priceDebtToColl,
    slippagePct: new Decimal(0.01),
    obligation,
    obligationTypeTagOverride: ObligationTypeTag.Multiply,
    referrer: none(),
    currentSlot: BigInt(slot),
    selectedTokenMint: address(USDC_MINT),
    scopeRefreshIx: [],
    quoteBufferBps: new Decimal(50),
    quoter: quoter as any,
    swapper: swapper as any,
    useV2Ixs: false,
  });

  console.log(`SDK returned ${responses.length} transaction(s)`);

  for (let i = 0; i < responses.length; i++) {
    const resp = responses[i]!;
    console.log(`\nTx ${i + 1}: ${resp.ixs.length} ixs, ${resp.lookupTables.length} ALTs`);

    const web3Ixs = resp.ixs.map(kitIxToWeb3);
    const web3ALTs = resp.lookupTables.filter((lt: any) => lt && lt.key && lt.state);

    const sig = await sendWeb3Tx(conn, keypair, web3Ixs, web3ALTs);
    console.log(`  Deposit tx: ${sig}`);
  }

  // ── Post-check ──
  console.log('\n--- Result ---');
  await new Promise(r => setTimeout(r, 3000));
  await market.loadReserves();
  const finalObl = await market.getObligationByWallet(signer.address, obligationType);
  if (finalObl) {
    const stats = finalObl.refreshedStats;
    const health = stats.userTotalBorrow.isZero()
      ? Infinity
      : stats.borrowLiquidationLimit.div(stats.userTotalBorrow).toNumber();
    console.log(`Health Rate: ${health === Infinity ? 'N/A' : health.toFixed(4)}`);
    console.log(`Deposited:   $${stats.userTotalDeposit.toFixed(2)}`);
    console.log(`Borrowed:    $${stats.userTotalBorrow.toFixed(2)}`);
    console.log(`Net Equity:  $${stats.userTotalDeposit.minus(stats.userTotalBorrow).toFixed(2)}`);
  } else {
    console.log('Obligation not found after deposit');
  }

  console.log('\nDone.');
}

main().catch(console.error);
