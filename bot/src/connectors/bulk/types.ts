// Bulk Trade API types

// ── Order input types ───────────────────────────────────────────────────────

/** Input to NativeSigner.signOrder() — one element per action. */
export type BulkOrderInput =
  | BulkPlaceOrderInput
  | BulkCancelOrderInput
  | BulkCancelAllInput;

/** Place a new order. */
export interface BulkPlaceOrderInput {
  type: 'order';
  symbol: string;        // e.g. 'SOL-USD'
  isBuy: boolean;        // false = short/sell
  /** Price in USD. Use 0 (sell) or very large (buy) for market-like fills. */
  price: number;
  size: number;          // in base asset units
  timeInForce: 'GTC' | 'IOC' | 'ALO';
  reduceOnly: boolean;
}

/** Cancel a specific order by ID. */
export interface BulkCancelOrderInput {
  type: 'cancel';
  symbol: string;
  orderId: string;       // base58 order ID
}

/** Cancel all open orders for a symbol. */
export interface BulkCancelAllInput {
  type: 'cancelAll';
  symbol: string;
}

// ── REST response types ─────────────────────────────────────────────────────

export interface BulkApiError {
  error: string;
  code?: number;
}

/** Response from POST /order */
export interface BulkOrderResponse {
  statuses: BulkOrderStatus[];
}

export type BulkOrderStatus =
  | { resting: { oid: string } }
  | { filled: { oid: string; totalSz: number; avgPx: number } }
  | { error: string }
  | { cancelled: { oid: string } };

/** POST /account with type='fullAccount' */
export interface BulkFullAccountResponse {
  marginSummary: BulkMarginSummary;
  positions: BulkPosition[];
  openOrders: BulkOpenOrder[];
  leverageSettings: Record<string, number>;
}

export interface BulkMarginSummary {
  /** Total USDC deposited as margin */
  accountValue: number;
  /** Available USDC margin not tied to positions */
  totalMarginUsed: number;
  totalRawUsd: number;
  totalNtlPos: number;
}

export interface BulkPosition {
  coin: string;              // e.g. 'SOL'
  szi: number;               // signed size: negative = short
  entryPx: number;
  positionValue: number;
  unrealizedPnl: number;
  returnOnEquity: number;
  liquidationPx: number | null;
  marginUsed: number;
  maxLeverage: number;
  cumFunding: {
    allTime: number;
    sinceOpen: number;
  };
}

export interface BulkOpenOrder {
  coin: string;
  side: 'A' | 'B'; // A=ask(sell), B=bid(buy)
  limitPx: number;
  sz: number;
  oid: string;
  timestamp: number;
  origSz: number;
  reduceOnly: boolean;
  tif: string;
}

/** GET /stats response (per-market stats with funding rates) */
export interface BulkStatsResponse {
  [symbol: string]: BulkMarketStats;
}

export interface BulkMarketStats {
  coin: string;
  markPx: number;
  midPx: number;
  prevDayPx: number;
  dayNtlVlm: number;
  openInterest: number;
  /** Hourly funding rate (as decimal, e.g. 0.0001 = 0.01%) */
  funding: number;
  /** Annualized funding rate derived from hourly rate × 8760 */
  fundingAnnualized?: number;
  premium: number;
}

// ── WebSocket message types ─────────────────────────────────────────────────

export interface BulkWsMessage {
  type: string;
  data?: unknown;
}

export interface BulkTickerData {
  coin: string;
  /** Current mark/fair price */
  fairPrice: number;
  /** 24h funding rate (hourly) */
  funding?: number;
  markPx?: number;
  midPx?: number;
  openInterest?: number;
}

export interface BulkSubscribeMessage {
  method: 'subscribe' | 'unsubscribe';
  subscription?: Array<{ type: string; symbol?: string; coin?: string }>;
  topic?: string;
}
