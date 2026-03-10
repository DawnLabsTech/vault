import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import type { LendingProtocol } from '../../types.js';
import {
  DriftClient,
  Wallet,
  QUOTE_SPOT_MARKET_INDEX,
  initialize,
  BulkAccountLoader,
} from '@drift-labs/sdk';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';

const log = createChildLogger('drift');

const DRIFT_API = 'https://data.api.drift.trade';

export class DriftLending implements LendingProtocol {
  readonly name = 'drift';
  private walletAddress: string;
  private driftClient: DriftClient | null = null;
  private rpcUrl: string | null = null;
  private secretKey: Uint8Array | null = null;
  private initialized = false;

  constructor(walletAddress: string, rpcUrl?: string, secretKey?: Uint8Array) {
    this.walletAddress = walletAddress;
    this.rpcUrl = rpcUrl ?? null;
    this.secretKey = secretKey ?? null;
  }

  private async ensureInitialized(): Promise<DriftClient> {
    if (this.driftClient && this.initialized) {
      return this.driftClient;
    }

    if (!this.rpcUrl || !this.secretKey) {
      throw new Error('Drift adapter not configured for on-chain operations (missing rpcUrl or secretKey)');
    }

    // Use Drift SDK's own @solana/web3.js to avoid type conflicts
    const driftSdk = await import('@drift-labs/sdk');
    const driftWeb3 = await import('@drift-labs/sdk/node_modules/@solana/web3.js/lib/index.js' as string).catch(
      () => import('@solana/web3.js'),
    );

    const connection = new driftWeb3.Connection(this.rpcUrl, 'confirmed');
    const keypair = driftWeb3.Keypair.fromSecretKey(this.secretKey);
    const wallet = new Wallet(keypair as any);

    const sdkConfig = initialize({ env: 'mainnet-beta' });

    const bulkAccountLoader = new BulkAccountLoader(connection as any, 'confirmed', 10_000);

    this.driftClient = new DriftClient({
      connection: connection as any,
      wallet,
      env: 'mainnet-beta',
      programID: new driftWeb3.PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
      accountSubscription: {
        type: 'polling',
        accountLoader: bulkAccountLoader,
      },
      spotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
    });

    await this.driftClient.subscribe();
    this.initialized = true;

    log.info('Drift client initialized and subscribed');
    return this.driftClient;
  }

  async getApy(): Promise<number> {
    return withRetry(async () => {
      const res = await fetch(`${DRIFT_API}/stats/USDC/rateHistory/deposit?period=1d`);
      if (!res.ok) {
        throw new Error(`Drift APY fetch failed: ${res.status}`);
      }
      const data = await res.json() as any;
      // Use the most recent rate entry
      if (Array.isArray(data) && data.length > 0) {
        const latest = data[data.length - 1];
        return latest?.rate ?? latest?.apy ?? 0;
      }
      return 0;
    }, 'drift-apy');
  }

  async getBalance(): Promise<number> {
    return withRetry(async () => {
      const res = await fetch(`${DRIFT_API}/authority/${this.walletAddress}/accounts`);
      if (!res.ok) {
        log.warn({ status: res.status }, 'Drift balance fetch failed, returning 0');
        return 0;
      }
      const data = await res.json() as any;
      // Find USDC spot position across all sub-accounts
      const accounts = Array.isArray(data) ? data : [data];
      for (const account of accounts) {
        const positions = account?.spotPositions ?? [];
        const usdcPosition = positions.find((p: any) => p.marketIndex === 0);
        if (usdcPosition?.scaledBalance) {
          return usdcPosition.scaledBalance;
        }
      }
      return 0;
    }, 'drift-balance');
  }

  async deposit(amount: number): Promise<string> {
    const client = await this.ensureInitialized();

    log.info({ amount }, 'Drift deposit starting');

    // USDC has 6 decimals
    const amountBN = new BN(Math.floor(amount * 1e6));

    // Get the USDC spot market account to find the mint
    const spotMarket = client.getQuoteSpotMarketAccount();
    const usdcMint = spotMarket.mint;

    // Get user's USDC token account
    const userTokenAccount = getAssociatedTokenAddressSync(
      usdcMint,
      client.wallet.publicKey,
    );

    // Initialize user account if needed
    try {
      await client.getUserAccountPublicKey();
    } catch {
      log.info('Initializing Drift user account');
      await client.initializeUserAccount();
    }

    const txSig = await client.deposit(
      amountBN,
      QUOTE_SPOT_MARKET_INDEX,
      userTokenAccount,
    );

    log.info({ amount, txSig }, 'Drift deposit complete');
    return txSig;
  }

  async withdraw(amount: number): Promise<string> {
    const client = await this.ensureInitialized();

    log.info({ amount }, 'Drift withdraw starting');

    const amountBN = new BN(Math.floor(amount * 1e6));

    const spotMarket = client.getQuoteSpotMarketAccount();
    const usdcMint = spotMarket.mint;

    const userTokenAccount = getAssociatedTokenAddressSync(
      usdcMint,
      client.wallet.publicKey,
    );

    const txSig = await client.withdraw(
      amountBN,
      QUOTE_SPOT_MARKET_INDEX,
      userTokenAccount,
    );

    log.info({ amount, txSig }, 'Drift withdraw complete');
    return txSig;
  }

  async cleanup(): Promise<void> {
    if (this.driftClient && this.initialized) {
      await this.driftClient.unsubscribe();
      this.initialized = false;
      log.info('Drift client unsubscribed');
    }
  }
}
