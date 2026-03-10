import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import type { LendingProtocol } from '../../types.js';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';

const log = createChildLogger('jupiter-lend');

/**
 * Jupiter Lend (Earn) API.
 *
 * Jupiter's lending API requires authentication (API key).
 * Set JUPITER_API_KEY in the environment to enable.
 *
 * API pattern follows Jupiter Swap: POST request returns a serialized
 * transaction that we sign and send.
 */
const JUPITER_LEND_API = 'https://api.jup.ag/lend/v1';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export class JupiterLending implements LendingProtocol {
  readonly name = 'jupiter';
  private walletAddress: string;
  private connection: Connection | null = null;
  private keypair: Keypair | null = null;
  private apiKey: string | null = null;

  constructor(walletAddress: string, rpcUrl?: string, secretKey?: Uint8Array) {
    this.walletAddress = walletAddress;
    this.apiKey = process.env.JUPITER_API_KEY ?? null;
    if (rpcUrl) {
      this.connection = new Connection(rpcUrl, 'confirmed');
    }
    if (secretKey) {
      this.keypair = Keypair.fromSecretKey(secretKey);
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }

  async getApy(): Promise<number> {
    return withRetry(async () => {
      const res = await fetch(
        `${JUPITER_LEND_API}/rates?mint=${USDC_MINT}`,
        { headers: this.getHeaders() },
      );
      if (!res.ok) {
        // Jupiter Lend may require API key; return 0 if unauthorized
        if (res.status === 401) {
          log.debug('Jupiter Lend API requires authentication, returning 0 APY');
          return 0;
        }
        throw new Error(`Jupiter Lend APY fetch failed: ${res.status}`);
      }
      const data = await res.json() as any;
      return data?.supplyApy ?? 0;
    }, 'jupiter-lend-apy');
  }

  async getBalance(): Promise<number> {
    return withRetry(async () => {
      const res = await fetch(
        `${JUPITER_LEND_API}/positions?wallet=${this.walletAddress}&mint=${USDC_MINT}`,
        { headers: this.getHeaders() },
      );
      if (!res.ok) {
        if (res.status === 401) {
          log.debug('Jupiter Lend API requires authentication, returning 0 balance');
          return 0;
        }
        log.warn({ status: res.status }, 'Jupiter Lend balance fetch failed, returning 0');
        return 0;
      }
      const data = await res.json() as any;
      return data?.balance ?? 0;
    }, 'jupiter-lend-balance');
  }

  async deposit(amount: number): Promise<string> {
    if (!this.connection || !this.keypair) {
      throw new Error('Jupiter Lend not configured for on-chain operations (missing rpcUrl or secretKey)');
    }
    if (!this.apiKey) {
      throw new Error('Jupiter Lend deposit requires JUPITER_API_KEY environment variable');
    }

    log.info({ amount }, 'Jupiter Lend deposit starting');

    // Jupiter Lend follows the same pattern as Jupiter Swap:
    // POST request returns a serialized transaction
    const amountBase = Math.floor(amount * 1e6); // USDC 6 decimals

    const res = await fetch(`${JUPITER_LEND_API}/deposit`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        mint: USDC_MINT,
        amount: amountBase.toString(),
        userPublicKey: this.walletAddress,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown');
      throw new Error(`Jupiter Lend deposit API failed: ${res.status} ${errText}`);
    }

    const data = await res.json() as any;
    const serializedTx = data.transaction;

    if (!serializedTx) {
      throw new Error('Jupiter Lend deposit: no transaction returned');
    }

    // Deserialize, sign, and send
    const txBuf = Buffer.from(serializedTx, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([this.keypair]);

    const signature = await this.connection.sendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });

    log.info({ amount, signature }, 'Jupiter Lend deposit sent');
    return signature;
  }

  async withdraw(amount: number): Promise<string> {
    if (!this.connection || !this.keypair) {
      throw new Error('Jupiter Lend not configured for on-chain operations (missing rpcUrl or secretKey)');
    }
    if (!this.apiKey) {
      throw new Error('Jupiter Lend withdraw requires JUPITER_API_KEY environment variable');
    }

    log.info({ amount }, 'Jupiter Lend withdraw starting');

    const amountBase = Math.floor(amount * 1e6);

    const res = await fetch(`${JUPITER_LEND_API}/withdraw`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        mint: USDC_MINT,
        amount: amountBase.toString(),
        userPublicKey: this.walletAddress,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown');
      throw new Error(`Jupiter Lend withdraw API failed: ${res.status} ${errText}`);
    }

    const data = await res.json() as any;
    const serializedTx = data.transaction;

    if (!serializedTx) {
      throw new Error('Jupiter Lend withdraw: no transaction returned');
    }

    const txBuf = Buffer.from(serializedTx, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([this.keypair]);

    const signature = await this.connection.sendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });

    log.info({ amount, signature }, 'Jupiter Lend withdraw sent');
    return signature;
  }
}
