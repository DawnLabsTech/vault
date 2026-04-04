/**
 * Jito Bundle sender — sends multiple transactions atomically via Jito block engine.
 *
 * All transactions in a bundle either succeed together or fail together.
 * A tip transaction is automatically appended to compensate the Jito validator.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('jito-bundle');

const JITO_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf';
const JITO_BUNDLE_ENDPOINT = `${JITO_BLOCK_ENGINE}/api/v1/bundles`;

// Jito tip accounts (randomly pick one for load distribution)
const JITO_TIP_ACCOUNTS = [
  'DttWaMuVnKgNcSiY1J3PftxoaXAhzDA1FWHeSZDUTdtY',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADaUMid9yfUytqMBgopwjb2DTLSLGJMvyrBa96TiWLki',
  'HFqU5x63VTqvQss8hp11i4bVqkfRKPSQRhkWCQhY3nLx',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
];

/** Default tip: 10,000 lamports (0.00001 SOL) */
const DEFAULT_TIP_LAMPORTS = 10_000;

export interface JitoBundleConfig {
  /** Tip amount in lamports (default: 10,000 = 0.00001 SOL) */
  tipLamports?: number;
  /** Max retries for bundle submission (default: 2) */
  maxRetries?: number;
  /** Poll interval in ms for bundle status (default: 2000) */
  pollIntervalMs?: number;
  /** Max wait time for bundle confirmation in ms (default: 30000) */
  maxWaitMs?: number;
}

export interface BundleResult {
  bundleId: string;
  status: 'landed' | 'failed' | 'timeout';
  /** Transaction signatures in bundle order */
  signatures: string[];
}

/**
 * Send multiple versioned transactions as an atomic Jito bundle.
 *
 * @param transactions - Array of VersionedTransaction (already signed except tip)
 * @param keypair - Signer for tip transaction
 * @param connection - Solana RPC connection
 * @param config - Optional bundle configuration
 * @returns BundleResult with bundle ID and status
 */
export async function sendJitoBundle(
  transactions: VersionedTransaction[],
  keypair: Keypair,
  connection: Connection,
  config: JitoBundleConfig = {},
): Promise<BundleResult> {
  const tipLamports = config.tipLamports ?? DEFAULT_TIP_LAMPORTS;
  const maxRetries = config.maxRetries ?? 2;
  const pollIntervalMs = config.pollIntervalMs ?? 2000;
  const maxWaitMs = config.maxWaitMs ?? 30_000;

  // Pick a random tip account
  const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;

  // Create tip transaction
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tipIx = SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: new PublicKey(tipAccount),
    lamports: tipLamports,
  });

  const tipMsg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [tipIx],
  }).compileToV0Message();

  const tipTx = new VersionedTransaction(tipMsg);
  tipTx.sign([keypair]);

  // Combine: user transactions + tip transaction
  const allTxs = [...transactions, tipTx];

  // Serialize all to base58 (Jito API requirement)
  const bs58 = (await import('bs58')).default;
  const serializedTxs = allTxs.map((tx) => {
    return bs58.encode(tx.serialize());
  });

  // Collect signatures for tracking
  const signatures = allTxs.map((tx) => {
    const sig = tx.signatures[0];
    return sig ? bs58.encode(Buffer.from(sig)) : 'unknown';
  });

  log.info(
    { txCount: allTxs.length, tipLamports, tipAccount: tipAccount.slice(0, 8) },
    'Sending Jito bundle',
  );

  // Submit bundle (with retries)
  let bundleId: string | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(JITO_BUNDLE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [serializedTxs],
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => 'unknown');
        throw new Error(`Jito API error: ${res.status} ${errText}`);
      }

      const data = (await res.json()) as any;
      if (data.error) {
        throw new Error(`Jito RPC error: ${JSON.stringify(data.error)}`);
      }

      bundleId = data.result;
      log.info({ bundleId, attempt }, 'Bundle submitted');
      break;
    } catch (err) {
      if (attempt < maxRetries) {
        log.warn({ attempt, error: (err as Error).message }, 'Bundle submission failed, retrying');
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        throw err;
      }
    }
  }

  if (!bundleId) {
    throw new Error('Failed to submit Jito bundle');
  }

  // Poll for bundle status
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const statusRes = await fetch(JITO_BUNDLE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        }),
      });

      const statusData = (await statusRes.json()) as any;
      const bundleStatus = statusData?.result?.value?.[0];

      if (bundleStatus) {
        const status = bundleStatus.confirmation_status;
        if (status === 'confirmed' || status === 'finalized') {
          log.info({ bundleId, status, slot: bundleStatus.slot }, 'Bundle landed');
          return { bundleId, status: 'landed', signatures };
        }
        if (bundleStatus.err) {
          log.error({ bundleId, err: bundleStatus.err }, 'Bundle failed');
          return { bundleId, status: 'failed', signatures };
        }
      }
    } catch {
      // Ignore polling errors, keep trying
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  log.warn({ bundleId, maxWaitMs }, 'Bundle confirmation timed out');
  return { bundleId, status: 'timeout', signatures };
}

/**
 * Split instructions into multiple transactions that each fit within Solana's size limit.
 * Each transaction uses the provided ALTs for address compression.
 *
 * @param instructions - All instructions to split
 * @param keypair - Transaction payer/signer
 * @param connection - Solana RPC connection
 * @param lookupTables - Address Lookup Tables for compression
 * @param maxTxSize - Max serialized size per tx (default: 1200, slightly under 1232 limit)
 * @returns Array of signed VersionedTransactions
 */
export async function splitAndSignTransactions(
  instructions: TransactionInstruction[],
  keypair: Keypair,
  connection: Connection,
  lookupTables: any[] = [],
  maxTxSize: number = 1200,
): Promise<VersionedTransaction[]> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const transactions: VersionedTransaction[] = [];

  let currentIxs: TransactionInstruction[] = [];

  for (const ix of instructions) {
    // Try adding this instruction
    const testIxs = [...currentIxs, ix];

    const testMsg = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: testIxs,
    }).compileToV0Message(lookupTables);

    const testTx = new VersionedTransaction(testMsg);

    try {
      const size = testTx.serialize().length;
      if (size <= maxTxSize) {
        currentIxs.push(ix);
      } else {
        // Current batch is full, finalize it
        if (currentIxs.length > 0) {
          const msg = new TransactionMessage({
            payerKey: keypair.publicKey,
            recentBlockhash: blockhash,
            instructions: currentIxs,
          }).compileToV0Message(lookupTables);
          const tx = new VersionedTransaction(msg);
          tx.sign([keypair]);
          transactions.push(tx);
        }
        // Start new batch with current instruction
        currentIxs = [ix];
      }
    } catch {
      // Serialization failed (too large even alone) — try without ALTs or skip
      if (currentIxs.length > 0) {
        const msg = new TransactionMessage({
          payerKey: keypair.publicKey,
          recentBlockhash: blockhash,
          instructions: currentIxs,
        }).compileToV0Message(lookupTables);
        const tx = new VersionedTransaction(msg);
        tx.sign([keypair]);
        transactions.push(tx);
        currentIxs = [];
      }
      // Try this instruction alone
      currentIxs = [ix];
    }
  }

  // Finalize remaining instructions
  if (currentIxs.length > 0) {
    const msg = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: currentIxs,
    }).compileToV0Message(lookupTables);
    const tx = new VersionedTransaction(msg);
    tx.sign([keypair]);
    transactions.push(tx);
  }

  log.info(
    { totalIxs: instructions.length, txCount: transactions.length },
    'Instructions split into transactions',
  );

  return transactions;
}
