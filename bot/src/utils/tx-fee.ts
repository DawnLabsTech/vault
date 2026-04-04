/**
 * Fetch transaction fee (SOL) from a confirmed Solana transaction.
 * Returns fee in SOL (not lamports). Returns 0 if fetch fails.
 */
import { createChildLogger } from './logger.js';

const log = createChildLogger('tx-fee');

export async function getTxFeeInSol(rpcUrl: string, txSig: string): Promise<number> {
  try {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [txSig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
    });

    // Wait briefly for tx to be indexed
    await new Promise((r) => setTimeout(r, 2000));

    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return 0;

    const json = (await res.json()) as any;
    const fee = json?.result?.meta?.fee;

    if (typeof fee === 'number') {
      const feeInSol = fee / 1e9;
      log.debug({ txSig: txSig.slice(0, 12), feeLamports: fee, feeSol: feeInSol }, 'Tx fee fetched');
      return feeInSol;
    }

    return 0;
  } catch (err) {
    log.debug({ txSig: txSig.slice(0, 12), error: (err as Error).message }, 'Failed to fetch tx fee');
    return 0;
  }
}
