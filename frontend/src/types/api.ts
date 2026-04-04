// Bot States
export type BotState = 'BASE_ONLY' | 'BASE_DN' | 'UNKNOWN';

// Event Types
export type EventType =
  | 'deposit' | 'withdraw' | 'swap'
  | 'perp_open' | 'perp_close' | 'fr_payment'
  | 'lending_interest' | 'rebalance' | 'alert'
  | 'state_change' | 'transfer';

// /api/status response
export interface StatusResponse {
  state: BotState;
  startedAt: string | null;
  uptime: number;
  snapshot: PortfolioSnapshot | null;
}

// Portfolio Snapshot
export interface PortfolioSnapshot {
  timestamp: string;
  totalNavUsdc: number;
  lendingBalance: number;
  lendingBreakdown: Record<string, number>;
  bufferUsdcBalance: number;
  dawnsolBalance: number;
  dawnsolUsdcValue: number;
  binanceUsdcBalance: number;
  binancePerpUnrealizedPnl: number;
  binancePerpSize: number;
  state: BotState;
  solPrice: number;
  dawnsolPrice: number;
}

// /api/performance response
export interface PerformanceSummary {
  totalReturn: number;
  annualizedReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  totalDays: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalFees: number;
}

// /api/pnl response item
export interface DailyPnL {
  date: string;
  startingNav: number;
  endingNav: number;
  dailyReturn: number;
  cumulativeReturn: number;
  realizedPnl: number;
  unrealizedPnl: number;
  lendingInterest: number;
  fundingReceived: number;
  fundingPaid: number;
  stakingAccrual: number;
  swapPnl: number;
  binanceTradingFee: number;
  binanceWithdrawFee: number;
  solanaGas: number;
  swapSlippage: number;
  lendingFee: number;
  totalFees: number;
  navHigh: number;
  navLow: number;
  maxDrawdown: number;
}

// /api/fr response item
export interface FundingRateData {
  symbol: string;
  fundingRate: number;
  fundingTime: number;
  markPrice?: number;
}

// /api/apys response
export interface ApysResponse {
  lending: { protocol: string; apy: number }[];
  dawnsolApy: number;
}

// /api/multiply response
export interface MultiplyResponse {
  positions: MultiplyPosition[];
  candidates: MultiplyMarketCandidate[];
}

export interface MultiplyPosition {
  label: string;
  balance: number;
  healthRate: number;
  effectiveApy: number;
  leverage: number;
  targetHealthRate: number;
  alertHealthRate: number;
  emergencyHealthRate: number;
}

export interface RiskDimensionScores {
  pegStability: number;
  liquidityDepth: number;
  reserveUtilization: number;
  tvlProtocol: number;
  borrowRateVol: number;
  collateralType: number;
}

export interface RiskAssessmentData {
  compositeScore: number;
  dimensions: RiskDimensionScores;
  riskPenalty: number;
  targetHealthRate: number;
  maxPositionCap: number;
  alertLevel: 'normal' | 'warning' | 'critical' | 'emergency';
}

export interface MultiplyMarketCandidate {
  label: string;
  effectiveApy: number;
  adjustedApy: number;
  movingAvg: number | null;
  riskTier: number;
  active: boolean;
  capacity: { remaining: number; utilizationRatio: number } | null;
  riskAssessment: RiskAssessmentData | null;
}

// /api/events response item
export interface LedgerEvent {
  timestamp: string;
  eventType: EventType;
  amount: number;
  asset: string;
  price?: number;
  txHash?: string;
  orderId?: string;
  fee?: number;
  feeAsset?: string;
  sourceProtocol?: string;
  metadata?: Record<string, unknown>;
}
