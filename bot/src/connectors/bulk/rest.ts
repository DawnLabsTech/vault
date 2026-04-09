import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import { createKeypair, createSigner } from './keychain.js';
import type { BulkSigner, SignedEnvelope } from './keychain.js';
import type {
  BulkApiError,
  BulkFullAccountResponse,
  BulkMarketStats,
  BulkOrderResponse,
  BulkOrderStatus,
  BulkPlaceOrderInput,
  BulkPosition,
  BulkStatsResponse,
} from './types.js';

const log = createChildLogger('bulk-rest');

const BASE_URL = 'https://exchange-api.bulk.trade/api/v1';

// For a short (sell) market-like order: use very low limit price — will immediately
// fill at best bid on the book. GTC ensures it stays if not immediately filled.
const MARKET_SELL_PRICE = 0.001;
// For a buy-to-close market-like order: use a very high limit price.
const MARKET_BUY_PRICE = 9_999_999;

// Size precision: 4 decimal places (lot size 0.0001 SOL)
const SIZE_PRECISION = 4;

function roundSize(n: number): number {
  return Math.floor(n * 10 ** SIZE_PRECISION) / 10 ** SIZE_PRECISION;
}

function isFilled(status: BulkOrderStatus): { totalSz: number; avgPx: number } | null {
  if ('filled' in status) return status.filled;
  return null;
}

export class BulkRestClient {
  private readonly signer: BulkSigner;
  private readonly pubkey: string;
  private readonly testnet: boolean;

  /**
   * @param secretKeySeed 32-byte Ed25519 private key seed.
   *   Pass `loadWalletFromEnv().secretKey.slice(0, 32)` to reuse the Solana wallet.
   * @param testnet      Set to true while Bulk mainnet is not yet live.
   */
  constructor(secretKeySeed: Uint8Array, testnet = true) {
    const keypair = createKeypair(secretKeySeed);
    this.signer = createSigner(keypair);
    this.pubkey = keypair.pubkey;
    this.testnet = testnet;

    log.info({ pubkey: this.pubkey, testnet }, 'Bulk REST client initialized');
  }

  get accountPubkey(): string {
    return this.pubkey;
  }

  // ── Account ────────────────────────────────────────────────────────────────

  async getFullAccount(): Promise<BulkFullAccountResponse> {
    return withRetry(
      () => this.unsignedPost<BulkFullAccountResponse>('/account', {
        type: 'fullAccount',
        user: this.pubkey,
      }),
      'getFullAccount',
    );
  }

  async getPosition(coin: string): Promise<BulkPosition | null> {
    const account = await this.getFullAccount();
    return account.positions.find((p) => p.coin === coin) ?? null;
  }

  async getMarginBalance(): Promise<number> {
    const account = await this.getFullAccount();
    // accountValue is total USDC deposited; subtract marginUsed to get available
    const { accountValue, totalMarginUsed } = account.marginSummary;
    return Math.max(0, accountValue - totalMarginUsed);
  }

  // ── Market data ────────────────────────────────────────────────────────────

  async getStats(symbol?: string): Promise<BulkStatsResponse> {
    const params = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
    return withRetry(
      () => this.get<BulkStatsResponse>(`/stats${params}`),
      'getStats',
    );
  }

  async getMarkPrice(symbol: string): Promise<number> {
    const stats = await this.getStats(symbol);
    const market = stats[symbol] as BulkMarketStats | undefined;
    if (!market) throw new Error(`No stats for symbol ${symbol}`);
    return market.markPx;
  }

  /**
   * Get the hourly funding rate, converted to annualized percentage.
   * Hourly rate × 8760 hours/year × 100 = annualized %.
   */
  async getFundingRateAnnualized(symbol: string): Promise<number> {
    const stats = await this.getStats(symbol);
    const market = stats[symbol] as BulkMarketStats | undefined;
    if (!market) throw new Error(`No stats for symbol ${symbol}`);
    // funding is hourly rate as decimal → annualize to %
    return market.funding * 8760 * 100;
  }

  // ── Order management ───────────────────────────────────────────────────────

  /**
   * Open a SOL-USD short position at market price.
   * Uses a limit order at near-zero price to guarantee immediate fill.
   *
   * @returns Filled size and average entry price.
   */
  async openShort(symbol: string, size: number): Promise<{ size: number; entryPrice: number; orderId: string }> {
    const qty = roundSize(size);

    const input: BulkPlaceOrderInput = {
      type: 'order',
      symbol,
      isBuy: false,
      price: MARKET_SELL_PRICE,
      size: qty,
      timeInForce: 'GTC',
      reduceOnly: false,
    };

    log.info({ symbol, size: qty }, 'Opening short via Bulk');
    const envelope = this.signer.signOrder([input]);
    const response = await withRetry(
      () => this.postOrder(envelope),
      'openShort',
      { maxAttempts: 2 },
    );

    const status = response.statuses[0];
    if (!status) throw new Error('No order status returned');

    const filled = isFilled(status);
    if (!filled) {
      const errMsg = 'error' in status ? status.error : JSON.stringify(status);
      throw new Error(`Short order not filled: ${errMsg}`);
    }

    const result = {
      size: filled.totalSz,
      entryPrice: filled.avgPx,
      orderId: envelope.orderId ?? '',
    };
    log.info(result, 'Short opened on Bulk');
    return result;
  }

  /**
   * Close the entire short position for the given symbol (reduce-only buy).
   *
   * @returns PnL and order ID.
   */
  async closeShort(symbol: string): Promise<{ pnl: number; orderId: string }> {
    // Get current position to determine size
    const coin = symbol.replace('-USD', '');
    const position = await this.getPosition(coin);
    if (!position || position.szi >= 0) {
      throw new Error(`No short position found for ${symbol}`);
    }

    const absSize = roundSize(Math.abs(position.szi));
    const unrealizedPnl = position.unrealizedPnl;

    const input: BulkPlaceOrderInput = {
      type: 'order',
      symbol,
      isBuy: true,
      price: MARKET_BUY_PRICE,
      size: absSize,
      timeInForce: 'GTC',
      reduceOnly: true,
    };

    log.info({ symbol, size: absSize }, 'Closing short via Bulk');
    const envelope = this.signer.signOrder([input]);
    const response = await withRetry(
      () => this.postOrder(envelope),
      'closeShort',
      { maxAttempts: 2 },
    );

    const status = response.statuses[0];
    if (!status) throw new Error('No order status returned');

    if ('error' in status) {
      throw new Error(`Close short failed: ${status.error}`);
    }

    const result = { pnl: unrealizedPnl, orderId: envelope.orderId ?? '' };
    log.info(result, 'Short closed on Bulk');
    return result;
  }

  /**
   * Cancel all open orders for the given symbol.
   */
  async cancelAll(symbol: string): Promise<void> {
    log.info({ symbol }, 'Cancelling all Bulk orders');
    const envelope = this.signer.signOrder([{ type: 'cancelAll', symbol }]);
    await withRetry(() => this.postOrder(envelope), 'cancelAll', { maxAttempts: 2 });
  }

  /**
   * Request testnet USDC from the faucet (testnet only, once per hour).
   * This funds the Bulk margin account for testing.
   */
  async requestFaucet(): Promise<void> {
    if (!this.testnet) {
      throw new Error('Faucet is only available on testnet');
    }
    log.info({ pubkey: this.pubkey }, 'Requesting Bulk testnet faucet');
    const envelope = this.signer.signFaucet(0);
    await withRetry(() => this.postOrder(envelope), 'requestFaucet', { maxAttempts: 2 });
    log.info('Bulk testnet faucet request sent');
  }

  // ── HTTP helpers ───────────────────────────────────────────────────────────

  private async postOrder(envelope: SignedEnvelope): Promise<BulkOrderResponse> {
    const res = await fetch(`${BASE_URL}/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });

    const text = await res.text();

    if (!res.ok) {
      let apiErr: BulkApiError | undefined;
      try { apiErr = JSON.parse(text) as BulkApiError; } catch { /* ignore */ }
      const msg = apiErr?.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`;
      log.error({ status: res.status, body: text.slice(0, 200) }, `Bulk POST /order failed: ${msg}`);
      throw new Error(`Bulk API error: ${msg}`);
    }

    return JSON.parse(text) as BulkOrderResponse;
  }

  private async unsignedPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await res.text();

    if (!res.ok) {
      let apiErr: BulkApiError | undefined;
      try { apiErr = JSON.parse(text) as BulkApiError; } catch { /* ignore */ }
      const msg = apiErr?.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`;
      throw new Error(`Bulk API error on ${path}: ${msg}`);
    }

    return JSON.parse(text) as T;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`);
    const text = await res.text();

    if (!res.ok) {
      throw new Error(`Bulk API GET ${path} failed: HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    return JSON.parse(text) as T;
  }
}
