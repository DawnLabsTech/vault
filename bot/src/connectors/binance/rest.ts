import { createHmac } from 'crypto';
import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import type {
  BinanceAccountInfo,
  BinanceApiError,
  BinanceBalance,
  BinanceDepositRecord,
  BinanceFundingRate,
  BinanceLeverageResult,
  BinanceOrder,
  BinancePlaceOrderParams,
  BinancePosition,
  BinancePremiumIndex,
  BinanceWithdrawRecord,
  BinanceWithdrawResult,
} from './types.js';

const log = createChildLogger('binance-rest');

const FUTURES_BASE_URLS = {
  prod: 'https://fapi.binance.com',
  testnet: 'https://testnet.binancefuture.com',
} as const;

const SPOT_BASE_URLS = {
  prod: 'https://api.binance.com',
  testnet: 'https://testnet.binance.vision',
} as const;

// Binance rate limit weight tracking
interface RateLimitState {
  usedWeight1m: number;
  lastResetTime: number;
}

export class BinanceRestClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly futuresBaseUrl: string;
  private readonly spotBaseUrl: string;
  private readonly rateLimit: RateLimitState = { usedWeight1m: 0, lastResetTime: Date.now() };

  constructor(apiKey: string, apiSecret: string, testnet = false) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.futuresBaseUrl = testnet ? FUTURES_BASE_URLS.testnet : FUTURES_BASE_URLS.prod;
    this.spotBaseUrl = testnet ? SPOT_BASE_URLS.testnet : SPOT_BASE_URLS.prod;

    log.info({ testnet, futuresBaseUrl: this.futuresBaseUrl }, 'Binance REST client initialized');
  }

  // ─── Futures API ────────────────────────────────────────

  async getAccount(): Promise<BinanceAccountInfo> {
    return withRetry(
      () => this.signedRequest<BinanceAccountInfo>('GET', '/fapi/v2/account', {}, 'futures'),
      'getAccount',
    );
  }

  async getPosition(symbol: string): Promise<BinancePosition[]> {
    return withRetry(
      () => this.signedRequest<BinancePosition[]>('GET', '/fapi/v2/positionRisk', { symbol }, 'futures'),
      'getPosition',
    );
  }

  async getFundingRate(symbol: string, limit = 100): Promise<BinanceFundingRate[]> {
    return withRetry(
      () => this.signedRequest<BinanceFundingRate[]>('GET', '/fapi/v1/fundingRate', { symbol, limit: String(limit) }, 'futures'),
      'getFundingRate',
    );
  }

  async getCurrentFundingRate(symbol: string): Promise<BinancePremiumIndex> {
    return withRetry(
      () => this.signedRequest<BinancePremiumIndex>('GET', '/fapi/v1/premiumIndex', { symbol }, 'futures'),
      'getCurrentFundingRate',
    );
  }

  async placeOrder(params: BinancePlaceOrderParams): Promise<BinanceOrder> {
    const body: Record<string, string> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      quantity: params.quantity,
    };
    if (params.price) body.price = params.price;
    if (params.timeInForce) body.timeInForce = params.timeInForce;
    if (params.reduceOnly !== undefined) body.reduceOnly = String(params.reduceOnly);
    if (params.newClientOrderId) body.newClientOrderId = params.newClientOrderId;
    if (params.positionSide) body.positionSide = params.positionSide;

    // LIMIT orders require timeInForce
    if (params.type === 'LIMIT' && !body.timeInForce) {
      body.timeInForce = 'GTC';
    }

    log.info({ symbol: params.symbol, side: params.side, type: params.type, quantity: params.quantity }, 'Placing order');

    return withRetry(
      () => this.signedRequest<BinanceOrder>('POST', '/fapi/v1/order', body, 'futures'),
      'placeOrder',
      { maxAttempts: 2 }, // fewer retries for order placement
    );
  }

  async cancelOrder(symbol: string, orderId: number): Promise<BinanceOrder> {
    log.info({ symbol, orderId }, 'Cancelling order');

    return withRetry(
      () => this.signedRequest<BinanceOrder>('DELETE', '/fapi/v1/order', { symbol, orderId: String(orderId) }, 'futures'),
      'cancelOrder',
      { maxAttempts: 2 },
    );
  }

  async setLeverage(symbol: string, leverage: number): Promise<BinanceLeverageResult> {
    log.info({ symbol, leverage }, 'Setting leverage');

    return withRetry(
      () => this.signedRequest<BinanceLeverageResult>('POST', '/fapi/v1/leverage', { symbol, leverage: String(leverage) }, 'futures'),
      'setLeverage',
    );
  }

  async getBalance(): Promise<BinanceBalance[]> {
    return withRetry(
      () => this.signedRequest<BinanceBalance[]>('GET', '/fapi/v2/balance', {}, 'futures'),
      'getBalance',
    );
  }

  // ─── Spot / SAPI (Withdraw & Deposit) ──────────────────

  async withdraw(asset: string, address: string, amount: string, network: string): Promise<BinanceWithdrawResult> {
    log.info({ asset, address: `${address.slice(0, 8)}...`, amount, network }, 'Submitting withdrawal');

    return withRetry(
      () => this.signedRequest<BinanceWithdrawResult>(
        'POST',
        '/sapi/v1/capital/withdraw/apply',
        { coin: asset, address, amount, network },
        'spot',
      ),
      'withdraw',
      { maxAttempts: 2 },
    );
  }

  async getDepositHistory(asset?: string): Promise<BinanceDepositRecord[]> {
    const params: Record<string, string> = {};
    if (asset) params.coin = asset;

    return withRetry(
      () => this.signedRequest<BinanceDepositRecord[]>('GET', '/sapi/v1/capital/deposit/hisrec', params, 'spot'),
      'getDepositHistory',
    );
  }

  async getWithdrawHistory(asset?: string): Promise<BinanceWithdrawRecord[]> {
    const params: Record<string, string> = {};
    if (asset) params.coin = asset;

    return withRetry(
      () => this.signedRequest<BinanceWithdrawRecord[]>('GET', '/sapi/v1/capital/withdraw/history', params, 'spot'),
      'getWithdrawHistory',
    );
  }

  // ─── Request Infrastructure ────────────────────────────

  private signParams(params: Record<string, string>): Record<string, string> {
    const timestamp = Date.now().toString();
    const allParams = { ...params, timestamp };
    const queryString = new URLSearchParams(allParams).toString();
    const signature = createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
    return { ...allParams, signature };
  }

  private async signedRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string>,
    apiType: 'futures' | 'spot',
  ): Promise<T> {
    const baseUrl = apiType === 'futures' ? this.futuresBaseUrl : this.spotBaseUrl;
    const signed = this.signParams(params);

    let url: string;
    const headers: Record<string, string> = {
      'X-MBX-APIKEY': this.apiKey,
    };

    let body: string | undefined;

    if (method === 'GET' || method === 'DELETE') {
      const qs = new URLSearchParams(signed).toString();
      url = `${baseUrl}${path}?${qs}`;
    } else {
      url = `${baseUrl}${path}`;
      body = new URLSearchParams(signed).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    log.debug({ method, path, apiType }, 'Sending request');

    const response = await fetch(url, { method, headers, body });

    // Track rate limit headers
    this.updateRateLimits(response);

    const text = await response.text();

    if (!response.ok) {
      let apiError: BinanceApiError | undefined;
      try {
        apiError = JSON.parse(text) as BinanceApiError;
      } catch {
        // not JSON
      }

      const errMsg = apiError
        ? `Binance API error ${apiError.code}: ${apiError.msg}`
        : `Binance HTTP ${response.status}: ${text.slice(0, 200)}`;

      log.error({ method, path, status: response.status, code: apiError?.code, msg: apiError?.msg }, errMsg);
      throw new Error(errMsg);
    }

    return JSON.parse(text) as T;
  }

  private updateRateLimits(response: Response): void {
    const weight = response.headers.get('x-mbx-used-weight-1m');
    if (weight) {
      this.rateLimit.usedWeight1m = parseInt(weight, 10);
      this.rateLimit.lastResetTime = Date.now();

      // Futures API limit is 2400/min, warn at 80%
      if (this.rateLimit.usedWeight1m > 1920) {
        log.warn({ usedWeight: this.rateLimit.usedWeight1m }, 'Approaching Binance rate limit (>80% of 2400/min)');
      } else if (this.rateLimit.usedWeight1m > 1200) {
        log.debug({ usedWeight: this.rateLimit.usedWeight1m }, 'Rate limit usage >50%');
      }
    }
  }

  /** Current rate limit usage for monitoring */
  getRateLimitUsage(): RateLimitState {
    return { ...this.rateLimit };
  }
}
