import { createChildLogger } from '../../utils/logger.js';
import { withRetry, type RetryOptions } from '../../utils/retry.js';

const log = createChildLogger('solana-rpc');

/** Solana JSON-RPC error codes */
const RPC_ERROR_CODES: Record<number, string> = {
  [-32600]: 'Invalid request',
  [-32601]: 'Method not found',
  [-32602]: 'Invalid params',
  [-32603]: 'Internal error',
  [-32700]: 'Parse error',
  [-32004]: 'Block not available',
  [-32005]: 'Node unhealthy',
  [-32006]: 'Slot skipped',
  [-32007]: 'No snapshot',
  [-32009]: 'Slot not in epoch',
  [-32010]: 'Slot not available',
  [-32014]: 'Max retries exceeded for send',
  [-32015]: 'Transaction simulation failed',
  [-32016]: 'Transaction precompile verification failure',
};

export class SolanaRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    const label = RPC_ERROR_CODES[code] ?? 'Unknown RPC error';
    super(`RPC error ${code} (${label}): ${message}`);
    this.name = 'SolanaRpcError';
  }
}

export class SolanaRpc {
  private readonly rpcUrl: string;
  private readonly retryOptions: RetryOptions;
  private requestId = 0;

  constructor(rpcUrl?: string, retryOptions?: RetryOptions) {
    this.rpcUrl = rpcUrl ?? process.env.HELIUS_RPC_URL ?? '';
    if (!this.rpcUrl) {
      throw new Error('Solana RPC URL not configured. Set HELIUS_RPC_URL env var.');
    }
    this.retryOptions = retryOptions ?? { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000 };
    log.info({ url: this.rpcUrl.replace(/\/\?api-key=.*/, '/?api-key=***') }, 'SolanaRpc initialized');
  }

  /**
   * Make a JSON-RPC call to the Solana node.
   */
  private async rpcCall<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const id = ++this.requestId;

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      throw new Error(`HTTP ${response.status} from RPC: ${text}`);
    }

    const json = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result?: T;
      error?: { code: number; message: string; data?: unknown };
    };

    if (json.error) {
      throw new SolanaRpcError(json.error.code, json.error.message, json.error.data);
    }

    return json.result as T;
  }

  /**
   * Retry-wrapped RPC call.
   */
  private async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return withRetry(() => this.rpcCall<T>(method, params), `rpc:${method}`, this.retryOptions);
  }

  /**
   * Get SOL balance for an address, returned in lamports.
   */
  async getBalance(address: string): Promise<number> {
    const result = await this.call<{ value: number }>('getBalance', [
      address,
      { commitment: 'confirmed' },
    ]);
    log.debug({ address, lamports: result.value }, 'getBalance');
    return result.value;
  }

  /**
   * Get SPL token balance for a specific token account or find by owner+mint.
   * Returns raw token amount (not UI amount, to avoid precision loss).
   */
  async getTokenBalance(address: string, mint: string): Promise<number> {
    // First find the token account for this owner+mint
    const accounts = await this.getTokenAccountsByOwner(address, mint);
    if (accounts.length === 0) {
      log.debug({ address, mint }, 'No token account found, balance is 0');
      return 0;
    }
    // Sum balances across all token accounts for this mint
    const total = accounts.reduce((sum, acct) => sum + acct.balance, 0);
    log.debug({ address, mint, total, accountCount: accounts.length }, 'getTokenBalance');
    return total;
  }

  /**
   * Get all token accounts owned by an address for a specific mint.
   */
  async getTokenAccountsByOwner(
    owner: string,
    mint: string,
  ): Promise<{ pubkey: string; balance: number }[]> {
    interface TokenAccountResult {
      value: Array<{
        pubkey: string;
        account: {
          data: {
            parsed: {
              info: {
                tokenAmount: {
                  amount: string;
                  decimals: number;
                  uiAmount: number;
                };
              };
            };
          };
        };
      }>;
    }

    const result = await this.call<TokenAccountResult>('getTokenAccountsByOwner', [
      owner,
      { mint },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);

    const accounts = result.value.map((entry) => ({
      pubkey: entry.pubkey,
      balance: Number(entry.account.data.parsed.info.tokenAmount.amount),
    }));

    log.debug({ owner, mint, count: accounts.length }, 'getTokenAccountsByOwner');
    return accounts;
  }

  /**
   * Submit a signed serialized transaction (base64 encoded).
   * Returns the transaction signature.
   */
  async sendTransaction(serializedTx: string): Promise<string> {
    const signature = await this.call<string>('sendTransaction', [
      serializedTx,
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      },
    ]);
    log.info({ signature }, 'Transaction sent');
    return signature;
  }

  /**
   * Confirm a transaction by polling for its status.
   * Returns true if confirmed, false if timed out or failed.
   */
  async confirmTransaction(signature: string, timeout = 60_000): Promise<boolean> {
    const start = Date.now();
    const pollInterval = 2_000;

    log.debug({ signature, timeout }, 'Confirming transaction');

    while (Date.now() - start < timeout) {
      try {
        interface SignatureStatus {
          confirmationStatus: string | null;
          err: unknown | null;
        }
        const result = await this.rpcCall<{
          value: Array<SignatureStatus | null>;
        }>('getSignatureStatuses', [[signature], { searchTransactionHistory: false }]);

        const status = result.value[0];

        if (status) {
          if (status.err) {
            log.error({ signature, err: status.err }, 'Transaction failed');
            return false;
          }
          if (
            status.confirmationStatus === 'confirmed' ||
            status.confirmationStatus === 'finalized'
          ) {
            log.info({ signature, status: status.confirmationStatus }, 'Transaction confirmed');
            return true;
          }
        }
      } catch (err) {
        log.warn({ signature, err }, 'Error polling transaction status');
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    log.warn({ signature, timeout }, 'Transaction confirmation timed out');
    return false;
  }

  /**
   * Get the latest blockhash and last valid block height.
   */
  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const result = await this.call<{
      value: { blockhash: string; lastValidBlockHeight: number };
    }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);

    log.debug(
      { blockhash: result.value.blockhash, lastValidBlockHeight: result.value.lastValidBlockHeight },
      'getLatestBlockhash',
    );

    return result.value;
  }

  /**
   * Get a parsed transaction by signature.
   */
  async getTransaction(signature: string): Promise<unknown> {
    const result = await this.call<unknown>('getTransaction', [
      signature,
      {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      },
    ]);

    log.debug({ signature, found: result !== null }, 'getTransaction');
    return result;
  }

  /**
   * Get the health/version of the connected node.
   */
  async getHealth(): Promise<boolean> {
    try {
      await this.rpcCall<string>('getHealth');
      return true;
    } catch {
      return false;
    }
  }
}
