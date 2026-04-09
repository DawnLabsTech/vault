// Bulk Trade API types — based on actual testnet API responses

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

/**
 * Response from POST /order
 * Shape: { "status": "ok", "response": { "type": "order", "data": { "statuses": [...] } } }
 */
export interface BulkOrderResponseRaw {
  status: string;
  response: {
    type: string;
    data: {
      statuses: Array<Record<string, BulkOrderStatusInner>>;
    };
  };
}

export interface BulkOrderStatusInner {
  /** Set for resting/filled orders */
  oid?: string;
  /** Present on fill */
  totalSz?: number;
  avgPx?: number;
  /** Present on faucet deposit */
  amount?: number;
  /** Present on risk-limit rejection */
  reason?: string;
  /** Present on error */
  error?: string;
}

/**
 * POST /account with type='fullAccount'
 * Response: [{ "fullAccount": { margin, positions, openOrders, leverageSettings } }]
 */
export interface BulkFullAccountRaw {
  fullAccount: {
    margin: BulkMargin;
    positions: BulkPositionRaw[];
    openOrders: BulkOpenOrderRaw[];
    leverageSettings: Array<{ symbol: string; leverage: number }>;
  };
}

export interface BulkMargin {
  totalBalance: number;
  availableBalance: number;
  marginUsed: number;
  notional: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  funding: number;
}

export interface BulkPositionRaw {
  symbol: string;         // e.g. 'SOL-USD'
  size: number;           // signed: negative = short, positive = long
  price: number;          // entry price
  fairPrice: number;      // current mark price
  notional: number;       // signed notional value
  unrealizedPnl: number;
  realizedPnl: number;
  liquidationPrice: number;
  leverage: number;
  maintenanceMargin: number;
  fees: number;
  funding: number;
  lambda: number;
  riskAllocation: number;
}

export interface BulkOpenOrderRaw {
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  orderId: string;
  timestamp: number;
  reduceOnly: boolean;
  timeInForce: string;
}

/** GET /stats?symbol=SOL-USD response */
export interface BulkStatsResponse {
  timestamp: number;
  period: string;
  volume: { totalUsd: number };
  openInterest: { totalUsd: number };
  funding: {
    rates: Record<string, {
      current: number;        // hourly rate as decimal (e.g. 0.000125)
      annualized: number;     // e.g. 0.136875 = 13.69% per year
    }>;
  };
  markets: BulkMarketStats[];
}

export interface BulkMarketStats {
  symbol: string;
  volume: number;
  quoteVolume: number;
  openInterest: number;
  fundingRate: number;            // hourly rate as decimal
  fundingRateAnnualized: number;  // annualized as decimal (not %)
  lastPrice: number;
  markPrice: number;
}

// ── Normalized account view ─────────────────────────────────────────────────

/** Parsed/normalized view of the account for internal use */
export interface BulkAccount {
  margin: BulkMargin;
  positions: BulkPositionRaw[];
  openOrders: BulkOpenOrderRaw[];
}

// ── WebSocket message types ─────────────────────────────────────────────────

export interface BulkWsMessage {
  type: string;
  data?: unknown;
}

export interface BulkTickerData {
  symbol?: string;
  coin?: string;
  /** Current mark/fair price */
  fairPrice?: number;
  markPx?: number;
  markPrice?: number;
  fundingRate?: number;
  openInterest?: number;
}

export interface BulkSubscribeMessage {
  method: 'subscribe' | 'unsubscribe';
  subscription?: Array<{ type: string; symbol?: string; coin?: string }>;
  topic?: string;
}
