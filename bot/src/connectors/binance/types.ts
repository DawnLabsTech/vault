// Binance Futures & Spot API types

export interface BinancePosition {
  symbol: string;
  positionAmt: string;
  unrealizedProfit: string;
  entryPrice: string;
  leverage: string;
  marginType: 'isolated' | 'cross';
  markPrice: string;
  liquidationPrice: string;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  notional: string;
  updateTime: number;
}

export interface BinanceBalance {
  accountAlias: string;
  asset: string;
  balance: string;
  crossWalletBalance: string;
  crossUnPnl: string;
  availableBalance: string;
  maxWithdrawAmount: string;
  marginAvailable: boolean;
  updateTime: number;
}

export interface BinanceAccountInfo {
  totalInitialMargin: string;
  totalMaintMargin: string;
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  totalCrossWalletBalance: string;
  totalCrossUnPnl: string;
  availableBalance: string;
  maxWithdrawAmount: string;
  assets: BinanceBalance[];
  positions: BinancePosition[];
  canTrade: boolean;
  canDeposit: boolean;
  canWithdraw: boolean;
  updateTime: number;
}

export type BinanceOrderSide = 'BUY' | 'SELL';
export type BinanceOrderType = 'LIMIT' | 'MARKET' | 'STOP' | 'STOP_MARKET' | 'TAKE_PROFIT' | 'TAKE_PROFIT_MARKET';
export type BinanceTimeInForce = 'GTC' | 'IOC' | 'FOK' | 'GTX';
export type BinanceOrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';

export interface BinanceOrder {
  orderId: number;
  symbol: string;
  status: BinanceOrderStatus;
  clientOrderId: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  cumQuote: string;
  timeInForce: BinanceTimeInForce;
  type: BinanceOrderType;
  side: BinanceOrderSide;
  reduceOnly: boolean;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  origType: BinanceOrderType;
  updateTime: number;
}

export interface BinanceFundingRate {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
  markPrice: string;
}

export interface BinancePremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  interestRate: string;
  time: number;
}

export interface BinanceWithdrawResult {
  id: string;
}

export interface BinanceDepositRecord {
  id: string;
  amount: string;
  coin: string;
  network: string;
  status: number; // 0:pending, 6:credited, 1:success
  address: string;
  txId: string;
  insertTime: number;
  confirmTimes: string;
}

export interface BinanceWithdrawRecord {
  id: string;
  amount: string;
  transactionFee: string;
  coin: string;
  status: number; // 0:Email Sent, 1:Cancelled, 2:Awaiting, 3:Rejected, 4:Processing, 5:Failure, 6:Completed
  address: string;
  txId: string;
  applyTime: string;
  network: string;
}

export interface BinancePlaceOrderParams {
  symbol: string;
  side: BinanceOrderSide;
  type: BinanceOrderType;
  quantity: string;
  price?: string;
  timeInForce?: BinanceTimeInForce;
  reduceOnly?: boolean;
  newClientOrderId?: string;
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';
}

export interface BinanceLeverageResult {
  leverage: number;
  maxNotionalValue: string;
  symbol: string;
}

// WebSocket stream types
export interface WsMarkPriceUpdate {
  e: 'markPriceUpdate';
  E: number; // event time
  s: string; // symbol
  p: string; // mark price
  i: string; // index price
  P: string; // estimated settle price
  r: string; // funding rate
  T: number; // next funding time
}

export interface BinanceApiError {
  code: number;
  msg: string;
}
