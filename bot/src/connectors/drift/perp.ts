import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import {
  DriftClient,
  Wallet,
  QUOTE_SPOT_MARKET_INDEX,
  initialize,
  BulkAccountLoader,
  PositionDirection,
  getMarketOrderParams,
  PRICE_PRECISION,
  BASE_PRECISION,
} from '@drift-labs/sdk';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';

const log = createChildLogger('drift-perp');

const DRIFT_API = 'https://data.api.drift.trade';

// SOL-PERP is market index 0 on Drift
const SOL_PERP_MARKET_INDEX = 0;

// Timeout for subscribe() to prevent hanging on startup
const SUBSCRIBE_TIMEOUT_MS = 30_000;

export class DriftPerp {
  private driftClient: DriftClient | null = null;
  private rpcUrl: string;
  private secretKey: Uint8Array;
  private walletAddress: string;
  private initialized = false;
  private initPromise: Promise<DriftClient> | null = null;
  private network: 'mainnet-beta' | 'devnet';

  constructor(
    rpcUrl: string,
    secretKey: Uint8Array,
    walletAddress: string,
    network: 'mainnet-beta' | 'devnet' = 'mainnet-beta',
  ) {
    this.rpcUrl = rpcUrl;
    this.secretKey = secretKey;
    this.walletAddress = walletAddress;
    this.network = network;
  }

  private async ensureInitialized(): Promise<DriftClient> {
    if (this.driftClient && this.initialized) {
      return this.driftClient;
    }

    // Promise guard: if already initializing, wait for the same promise
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();

    try {
      const client = await this.initPromise;
      return client;
    } catch (err) {
      // Reset on failure so next call retries
      this.initPromise = null;
      throw err;
    }
  }

  private async doInitialize(): Promise<DriftClient> {
    // Use Drift SDK's own @solana/web3.js to avoid type conflicts
    const driftWeb3 = await import(
      '@drift-labs/sdk/node_modules/@solana/web3.js/lib/index.js' as string
    ).catch(() => import('@solana/web3.js'));

    const connection = new driftWeb3.Connection(this.rpcUrl, 'confirmed');
    const keypair = driftWeb3.Keypair.fromSecretKey(this.secretKey);
    const wallet = new Wallet(keypair as any);

    const sdkConfig = initialize({ env: this.network });

    const bulkAccountLoader = new BulkAccountLoader(
      connection as any,
      'confirmed',
      10_000,
    );

    this.driftClient = new DriftClient({
      connection: connection as any,
      wallet,
      env: this.network,
      programID: new driftWeb3.PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
      accountSubscription: {
        type: 'polling',
        accountLoader: bulkAccountLoader,
      },
      perpMarketIndexes: [SOL_PERP_MARKET_INDEX],
      spotMarketIndexes: [QUOTE_SPOT_MARKET_INDEX],
    });

    // Subscribe with timeout to prevent hanging
    await Promise.race([
      this.driftClient.subscribe(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Drift subscribe() timed out')), SUBSCRIBE_TIMEOUT_MS),
      ),
    ]);

    // Set initialized AFTER successful subscribe
    this.initialized = true;

    log.info({ network: this.network }, 'Drift perp client initialized');
    return this.driftClient;
  }

  /** Deposit USDC as perp margin into Drift */
  async depositMargin(usdcAmount: number): Promise<string> {
    return withRetry(async () => {
      const client = await this.ensureInitialized();
      const amountBN = new BN(Math.floor(usdcAmount * 1e6));

      const spotMarket = client.getQuoteSpotMarketAccount();
      const usdcMint = spotMarket.mint;
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
      log.info({ usdcAmount, txSig }, 'Deposited USDC margin to Drift');
      return txSig;
    }, 'drift-depositMargin');
  }

  /** Withdraw USDC margin from Drift */
  async withdrawMargin(usdcAmount: number): Promise<string> {
    return withRetry(async () => {
      const client = await this.ensureInitialized();
      const amountBN = new BN(Math.floor(usdcAmount * 1e6));

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
      log.info({ usdcAmount, txSig }, 'Withdrew USDC margin from Drift');
      return txSig;
    }, 'drift-withdrawMargin');
  }

  /** Open a SOL-PERP short position */
  async openShort(
    solAmount: number,
    leverage?: number,
  ): Promise<{ size: number; entryPrice: number; orderId: string }> {
    return withRetry(async () => {
      const client = await this.ensureInitialized();

      // Set leverage if specified (Drift uses sub-account margin mode)
      if (leverage && leverage > 1) {
        try {
          // Drift doesn't have a direct setLeverage API like Binance.
          // Leverage is determined by the margin deposited relative to position size.
          // Log the intended leverage for monitoring purposes.
          log.info({ leverage }, 'Drift target leverage (controlled via margin sizing)');
        } catch (err) {
          log.warn({ err, leverage }, 'Failed to configure Drift leverage');
        }
      }

      // Drift uses 1e9 base precision for perp amounts
      const baseAmount = new BN(Math.floor(solAmount * 1e9));

      const txSig = await client.placePerpOrder(
        getMarketOrderParams({
          marketIndex: SOL_PERP_MARKET_INDEX,
          direction: PositionDirection.SHORT,
          baseAssetAmount: baseAmount,
        }),
      );

      // Fetch resulting position to get fill details
      const user = client.getUser();
      const position = user.getPerpPosition(SOL_PERP_MARKET_INDEX);

      let size = solAmount;
      let entryPrice = 0;

      if (position && !position.baseAssetAmount.isZero()) {
        size = Math.abs(position.baseAssetAmount.toNumber()) / BASE_PRECISION.toNumber();
        // entryPrice = |quoteEntry| / |baseAmount| * (BASE_PRECISION / PRICE_PRECISION)
        // quoteEntryAmount is in PRICE_PRECISION (1e6), baseAssetAmount is in BASE_PRECISION (1e9)
        const quoteEntry = Math.abs(position.quoteEntryAmount.toNumber());
        const baseAmt = Math.abs(position.baseAssetAmount.toNumber());
        entryPrice = (quoteEntry / baseAmt) * (BASE_PRECISION.toNumber() / PRICE_PRECISION.toNumber());
      }

      log.info({ solAmount, size, entryPrice, txSig }, 'Drift short opened');
      return { size, entryPrice, orderId: txSig };
    }, 'drift-openShort');
  }

  /** Close the current SOL-PERP short position */
  async closeShort(): Promise<{ pnl: number; orderId: string }> {
    return withRetry(async () => {
      const client = await this.ensureInitialized();
      const user = client.getUser();
      const position = user.getPerpPosition(SOL_PERP_MARKET_INDEX);

      if (!position || position.baseAssetAmount.isZero()) {
        throw new Error('No open SOL-PERP position found on Drift');
      }

      const posSize = position.baseAssetAmount.abs();

      // Close short = buy back (LONG direction)
      const txSig = await client.placePerpOrder(
        getMarketOrderParams({
          marketIndex: SOL_PERP_MARKET_INDEX,
          direction: PositionDirection.LONG,
          baseAssetAmount: posSize,
          reduceOnly: true,
        }),
      );

      // PnL from settled quote amounts (USDC, 6 decimals)
      const pnl = position.quoteAssetAmount.toNumber() / PRICE_PRECISION.toNumber();

      log.info({ pnl, txSig }, 'Drift short closed');
      return { pnl, orderId: txSig };
    }, 'drift-closeShort');
  }

  /** Get current position info for portfolio snapshots */
  async getPosition(): Promise<{
    size: number;
    unrealizedPnl: number;
    entryPrice: number;
  }> {
    try {
      const client = await this.ensureInitialized();
      const user = client.getUser();
      const position = user.getPerpPosition(SOL_PERP_MARKET_INDEX);

      if (!position || position.baseAssetAmount.isZero()) {
        return { size: 0, unrealizedPnl: 0, entryPrice: 0 };
      }

      const size = Math.abs(position.baseAssetAmount.toNumber()) / BASE_PRECISION.toNumber();
      const unrealizedPnl = position.quoteAssetAmount.toNumber() / PRICE_PRECISION.toNumber();

      const quoteEntry = Math.abs(position.quoteEntryAmount.toNumber());
      const baseAmt = Math.abs(position.baseAssetAmount.toNumber());
      const entryPrice = (quoteEntry / baseAmt) * (BASE_PRECISION.toNumber() / PRICE_PRECISION.toNumber());

      return { size, unrealizedPnl, entryPrice };
    } catch (err) {
      log.warn({ err }, 'Failed to get Drift position');
      return { size: 0, unrealizedPnl: 0, entryPrice: 0 };
    }
  }

  /** Get USDC balance in Drift account via REST API */
  async getUsdcBalance(): Promise<number> {
    return withRetry(async () => {
      const res = await fetch(
        `${DRIFT_API}/authority/${this.walletAddress}/accounts`,
      );
      if (!res.ok) {
        throw new Error(`Drift API returned ${res.status}: ${res.statusText}`);
      }
      const data = (await res.json()) as any;
      const accounts = Array.isArray(data) ? data : [data];
      for (const account of accounts) {
        const positions = account?.spotPositions ?? [];
        const usdcPosition = positions.find(
          (p: any) => p.marketIndex === 0,
        );
        if (usdcPosition?.scaledBalance) {
          return usdcPosition.scaledBalance;
        }
      }
      return 0;
    }, 'drift-getUsdcBalance').catch((err) => {
      log.error({ err }, 'Failed to get Drift USDC balance after retries');
      return 0;
    });
  }

  /** Get SOL price from Drift oracle */
  async getSolPrice(): Promise<number> {
    const client = await this.ensureInitialized();
    const oracleData = client.getOracleDataForPerpMarket(
      SOL_PERP_MARKET_INDEX,
    );
    return oracleData.price.toNumber() / PRICE_PRECISION.toNumber();
  }

  /** Get current funding rate for SOL-PERP */
  async getFundingRate(): Promise<number> {
    return withRetry(async () => {
      const res = await fetch(
        `${DRIFT_API}/fundingRates?marketIndex=${SOL_PERP_MARKET_INDEX}`,
      );
      if (!res.ok) {
        throw new Error(`Drift funding rate API returned ${res.status}: ${res.statusText}`);
      }
      const json = (await res.json()) as any;
      const records: any[] = json.fundingRates ?? (Array.isArray(json) ? json : []);
      if (records.length > 0) {
        const latest = records[records.length - 1];
        // Drift fundingRate is absolute (USD/SOL/hour); divide by oracle price for %
        const rawFr = parseInt(latest.fundingRate);
        const oracle = parseInt(latest.oraclePriceTwap);
        if (oracle > 0) {
          return (rawFr / 1e9) / (oracle / 1e6);
        }
        return 0;
      }
      return 0;
    }, 'drift-getFundingRate').catch((err) => {
      log.error({ err }, 'Failed to get Drift funding rate after retries');
      return 0;
    });
  }

  async cleanup(): Promise<void> {
    if (this.driftClient && this.initialized) {
      await this.driftClient.unsubscribe();
      this.initialized = false;
      this.initPromise = null;
      log.info('Drift perp client unsubscribed');
    }
  }
}
