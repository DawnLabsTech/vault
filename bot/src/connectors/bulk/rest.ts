import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import { createKeypair, createSigner } from './keychain.js';
import type { BulkSigner, SignedEnvelope } from './keychain.js';
import type {
  BulkAccount,
  BulkApiError,
  BulkFullAccountRaw,
  BulkMarketStats,
  BulkOpenOrderRaw,
  BulkOrderResponseRaw,
  BulkPlaceOrderInput,
  BulkPositionRaw,
  BulkStatsResponse,
} from './types.js';

const log = createChildLogger('bulk-rest');

const BASE_URL = 'https://exchange-api.bulk.trade/api/v1';

// Price offset for market-like orders.
// Bulk enforces a ±5000 bps (50%) price band around fair price.
// Using ±10% guarantees we're within limits while still crossing the spread immediately.
const MARKET_SELL_SLIPPAGE = 0.10;  // sell at markPrice * (1 - 0.10)
const MARKET_BUY_SLIPPAGE  = 0.10;  // buy  at markPrice * (1 + 0.10)

// Size precision: 4 decimal places (lot size 0.0001 SOL per spec)
const SIZE_PRECISION = 4;

function roundSize(n: number): number {
  return Math.floor(n * 10 ** SIZE_PRECISION) / 10 ** SIZE_PRECISION;
}

export class BulkRestClient {
  private readonly signer: BulkSigner;
  private readonly pubkey: string;
  private readonly testnet: boolean;

  /**
   * @param secretKeySeed 32-byte private key seed derived from the wallet.
   *   NOTE: The resulting Bulk pubkey is NOT the same as the Solana wallet address —
   *   Bulk uses its own Ed25519 address space. Use `accountPubkey` to get the Bulk address.
   * @param testnet Set to true while Bulk mainnet is not yet live.
   */
  constructor(secretKeySeed: Uint8Array, testnet = true) {
    const keypair = createKeypair(secretKeySeed);
    this.signer = createSigner(keypair);
    this.pubkey = keypair.pubkey;
    this.testnet = testnet;

    log.info({ bulkPubkey: this.pubkey, testnet }, 'Bulk REST client initialized');
  }

  /** Bulk account address (different from Solana wallet address). */
  get accountPubkey(): string {
    return this.pubkey;
  }

  // ── Account ────────────────────────────────────────────────────────────────

  async getAccount(): Promise<BulkAccount> {
    const raw = await withRetry(
      () => this.unsignedPost<BulkFullAccountRaw[]>('/account', {
        type: 'fullAccount',
        user: this.pubkey,
      }),
      'getAccount',
    );

    // Response is: [{ "fullAccount": { margin, positions, openOrders, leverageSettings } }]
    const data = raw[0]?.fullAccount;
    if (!data) throw new Error('Unexpected /account response structure');

    return {
      margin: data.margin,
      positions: data.positions,
      openOrders: data.openOrders,
    };
  }

  async getPosition(symbol: string): Promise<BulkPositionRaw | null> {
    const account = await this.getAccount();
    return account.positions.find((p) => p.symbol === symbol && p.size !== 0) ?? null;
  }

  isShort(position: BulkPositionRaw): boolean {
    return position.size < 0;
  }

  /** Available USDC margin (totalBalance - marginUsed). */
  async getMarginBalance(): Promise<number> {
    const account = await this.getAccount();
    return Math.max(0, account.margin.totalBalance - account.margin.marginUsed);
  }

  async getOpenOrders(symbol?: string): Promise<BulkOpenOrderRaw[]> {
    const account = await this.getAccount();
    return symbol
      ? account.openOrders.filter((o) => o.symbol === symbol)
      : account.openOrders;
  }

  // ── Market data ────────────────────────────────────────────────────────────

  async getStats(symbol?: string): Promise<BulkStatsResponse> {
    const params = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
    return withRetry(
      () => this.get<BulkStatsResponse>(`/stats${params}`),
      'getStats',
    );
  }

  /** Returns the current mark price for the given symbol. */
  async getMarkPrice(symbol: string): Promise<number> {
    const stats = await this.getStats(symbol);
    const market = stats.markets.find((m) => m.symbol === symbol);
    if (!market) throw new Error(`No stats for symbol ${symbol}`);
    return market.markPrice;
  }

  /**
   * Returns the annualized funding rate as a decimal (e.g. 0.1369 = 13.69%).
   * Multiply by 100 to get a percentage.
   */
  async getFundingRateAnnualized(symbol: string): Promise<number> {
    const stats = await this.getStats(symbol);
    const rate = stats.funding.rates[symbol];
    if (!rate) throw new Error(`No funding rate for ${symbol}`);
    return rate.annualized;
  }

  getMarketStats(stats: BulkStatsResponse, symbol: string): BulkMarketStats | undefined {
    return stats.markets.find((m) => m.symbol === symbol);
  }

  // ── Order management ───────────────────────────────────────────────────────

  /**
   * Open a short position at market price.
   * Places a limit sell at markPrice × (1 - MARKET_SELL_SLIPPAGE) to guarantee immediate fill
   * while staying within Bulk's ±5000 bps price band.
   */
  async openShort(symbol: string, size: number): Promise<{ size: number; entryPrice: number; orderId: string }> {
    const qty = roundSize(size);
    const markPrice = await this.getMarkPrice(symbol);
    const sellPrice = parseFloat((markPrice * (1 - MARKET_SELL_SLIPPAGE)).toFixed(3));

    const input: BulkPlaceOrderInput = {
      type: 'order',
      symbol,
      isBuy: false,
      price: sellPrice,
      size: qty,
      timeInForce: 'GTC',
      reduceOnly: false,
    };
    log.info({ symbol, size: qty, sellPrice, markPrice }, 'Opening short via Bulk');

    const envelope = this.signer.signOrder([input]);
    const raw = await withRetry(
      () => this.postOrder(envelope),
      'openShort',
      { maxAttempts: 2 },
    );

    return this.parseFillResult(raw, envelope.orderId ?? '');
  }

  /**
   * Close the entire short position for the given symbol (reduce-only buy).
   */
  async closeShort(symbol: string): Promise<{ pnl: number; orderId: string }> {
    const position = await this.getPosition(symbol);
    if (!position || !this.isShort(position)) {
      throw new Error(`No short position found for ${symbol}`);
    }

    const absSize = roundSize(Math.abs(position.size));
    const unrealizedPnl = position.unrealizedPnl;
    const markPrice = await this.getMarkPrice(symbol);
    const buyPrice = parseFloat((markPrice * (1 + MARKET_BUY_SLIPPAGE)).toFixed(3));

    const input: BulkPlaceOrderInput = {
      type: 'order',
      symbol,
      isBuy: true,
      price: buyPrice,
      size: absSize,
      timeInForce: 'GTC',
      reduceOnly: true,
    };

    log.info({ symbol, size: absSize }, 'Closing short via Bulk');
    const envelope = this.signer.signOrder([input]);
    await withRetry(
      () => this.postOrder(envelope),
      'closeShort',
      { maxAttempts: 2 },
    );

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

  // ── Internal helpers ───────────────────────────────────────────────────────

  private parseFillResult(raw: BulkOrderResponseRaw, fallbackOrderId: string): { size: number; entryPrice: number; orderId: string } {
    // Response shape: { status: "ok", response: { type: "order", data: { statuses: [...] } } }
    const statuses = raw.response?.data?.statuses ?? [];
    const first = statuses[0];
    if (!first) throw new Error('Empty order response statuses');

    const statusKey = Object.keys(first)[0] as string;
    const statusData = first[statusKey]!;

    log.debug({ statusKey, statusData }, 'Order status received');

    if (statusKey === 'filled') {
      return {
        size: statusData.totalSz ?? 0,
        entryPrice: statusData.avgPx ?? 0,
        orderId: statusData.oid ?? fallbackOrderId,
      };
    }

    if (statusKey === 'resting') {
      // Order is on the book but not immediately filled
      log.info({ oid: statusData.oid }, 'Order resting on book (not immediately filled)');
      return { size: 0, entryPrice: 0, orderId: statusData.oid ?? fallbackOrderId };
    }

    if (statusKey === 'rejectedRiskLimit') {
      throw new Error(`Order rejected (risk limit): ${statusData.reason ?? JSON.stringify(statusData)}`);
    }

    if (statusKey === 'error') {
      throw new Error(`Order failed: ${statusData.error ?? JSON.stringify(statusData)}`);
    }

    log.warn({ statusKey, statusData }, 'Unexpected order status');
    return { size: 0, entryPrice: 0, orderId: fallbackOrderId };
  }

  private async postOrder(envelope: SignedEnvelope): Promise<BulkOrderResponseRaw> {
    // The bulk-keychain library returns `actions` as a JSON string.
    // The API expects `actions` to be a JSON array (not a string), so parse it here.
    const body = {
      ...envelope,
      actions: JSON.parse(envelope.actions) as unknown[],
    };

    const res = await fetch(`${BASE_URL}/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await res.text();

    if (!res.ok) {
      let apiErr: BulkApiError | undefined;
      try { apiErr = JSON.parse(text) as BulkApiError; } catch { /* ignore */ }
      const msg = apiErr?.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`;
      log.error({ status: res.status, body: text.slice(0, 200) }, `Bulk POST /order failed: ${msg}`);
      throw new Error(`Bulk API error: ${msg}`);
    }

    log.debug({ body: text.slice(0, 200) }, 'Bulk /order response');
    return JSON.parse(text) as BulkOrderResponseRaw;
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
