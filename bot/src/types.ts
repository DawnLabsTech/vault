// Bot States
export enum BotState {
  BASE_ONLY = 'BASE_ONLY',
  BASE_DN = 'BASE_DN',
}

// State Machine Actions
export enum ActionType {
  DN_ENTRY = 'DN_ENTRY',
  DN_EXIT = 'DN_EXIT',
  REBALANCE_LENDING = 'REBALANCE_LENDING',
  EMERGENCY_EXIT = 'EMERGENCY_EXIT',
}

export interface Action {
  type: ActionType;
  params: Record<string, unknown>;
  timestamp: number;
}

// Events for the ledger
export enum EventType {
  DEPOSIT = 'deposit',
  WITHDRAW = 'withdraw',
  SWAP = 'swap',
  PERP_OPEN = 'perp_open',
  PERP_CLOSE = 'perp_close',
  FR_PAYMENT = 'fr_payment',
  LENDING_INTEREST = 'lending_interest',
  REBALANCE = 'rebalance',
  ALERT = 'alert',
  STATE_CHANGE = 'state_change',
  TRANSFER = 'transfer',
}

export interface LedgerEvent {
  timestamp: string; // ISO 8601 UTC
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

// Portfolio Snapshot
export interface PortfolioSnapshot {
  timestamp: string;
  totalNavUsdc: number;
  lendingBalance: number;
  lendingBreakdown: Record<string, number>; // protocol -> balance
  dawnsolBalance: number;
  dawnsolUsdcValue: number;
  bufferUsdcBalance: number;
  binanceUsdcBalance: number;
  binancePerpUnrealizedPnl: number;
  binancePerpSize: number;
  state: BotState;
  solPrice: number;
  dawnsolPrice: number;
}

// Daily PnL
export interface DailyPnL {
  date: string; // YYYY-MM-DD
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

// FR Data
export interface FundingRateData {
  symbol: string;
  fundingRate: number;
  fundingTime: number; // unix ms
  markPrice?: number;
}

// Capacity info for deposit limit checks
export interface CapacityInfo {
  /** Deposit limit configured on the reserve (in token units) */
  depositLimit: number;
  /** Current total supply in the reserve (in token units) */
  totalSupply: number;
  /** Remaining deposit capacity (depositLimit - totalSupply) */
  remaining: number;
  /** Utilization ratio of the reserve (0-1) */
  utilizationRatio: number;
  /** Daily deposit/withdrawal cap remaining (in token units), null if no cap */
  dailyCapRemaining: number | null;
}

// Lending Protocol Interface
export interface LendingProtocol {
  name: string;
  getApy(): Promise<number>;
  getBalance(): Promise<number>;
  deposit(amount: number): Promise<string>; // returns tx sig
  withdraw(amount: number): Promise<string>;
  /** Get deposit capacity info (optional — not all protocols track this) */
  getCapacity?(): Promise<CapacityInfo>;
}

// Config
export type PerpExchange = 'binance';

export interface VaultConfig {
  general: {
    dryRun: boolean;
    logLevel: string;
    tickIntervalMs: number;
    snapshotIntervalMs: number;
    lendingRebalanceIntervalMs: number;
    dailyPnlTimeUtc: string; // "00:00"
  };
  perp: {
    exchange: PerpExchange;
    symbol: string;       // 'SOLUSDC' for Binance, 'SOL-PERP' for Drift
    leverage: number;
    swapSlippageBps: number;
  };
  binance: {
    symbol: string;
    leverage: number;
    testnet: boolean;
    swapSlippageBps: number;
  };
  solana: {
    network: 'mainnet-beta' | 'devnet';
  };
  thresholds: {
    frEntryAnnualized: number;      // annualized FR % to enter DN
    frEntryConfirmationDays: number;
    frExitAnnualized: number;
    frExitConfirmationDays: number;
    frEmergencyAnnualized: number;
    dnAllocationMax: number;        // 0-1
    lendingRebalanceMinDiffBps: number;
  };
  risk: {
    dailyLossLimitPct: number;
    maxPositionCapUsd: number;
    maxTransferSizeUsd: number;
    positionDivergenceThresholdPct: number;
  };
  lending: {
    protocols: string[];
    bufferPct: number; // keep this % liquid for withdrawals
  };
  kaminoLoop?: {
    targetHealthRate: number;   // default 1.15
    liquidationLtv: number;     // default 0.85
    alertHealthRate: number;    // default 1.10
    emergencyHealthRate: number; // default 1.05
  };
  kaminoMultiply?: Array<{
    market: string;
    collToken: string;
    debtToken: string;
    label: string;
    targetHealthRate: number;
    alertHealthRate: number;
    emergencyHealthRate: number;
    collDecimals?: number;
    debtDecimals?: number;
    collNativeYield?: number;
    claimRewards?: boolean;
    /** Token held in wallet (e.g. USDC). Auto-swaps to/from collToken if different */
    inputToken?: string;
    inputDecimals?: number;
  }>;
  kaminoMultiplyCandidates?: MultiplyCandidate[];
  multiplyRebalance?: MultiplyRebalanceConfig;
  riskScorer?: RiskScorerConfig;
}

// ── Risk Scoring ──

export interface RiskDimensionScores {
  /** D1: Peg deviation between collateral and debt (0-100) */
  pegStability: number;
  /** D2: Slippage on emergency exit swap (0-100) */
  liquidityDepth: number;
  /** D3: Kamino reserve utilization pressure (0-100) */
  reserveUtilization: number;
  /** D4: Market TVL / maturity (0-100) */
  tvlProtocol: number;
  /** D5: Borrow rate 24h volatility (0-100) */
  borrowRateVol: number;
  /** D6: Collateral token age / holder count (0-100) */
  collateralType: number;
}

export type RiskAlertLevel = 'normal' | 'warning' | 'critical' | 'emergency';

export interface RiskAssessment {
  label: string;
  compositeScore: number; // 0-100
  dimensions: RiskDimensionScores;
  /** Derived APY penalty (decimal, e.g. 0.005 = 0.5%) */
  riskPenalty: number;
  /** Derived target health rate */
  targetHealthRate: number;
  /** Derived max position cap in USD */
  maxPositionCap: number;
  alertLevel: RiskAlertLevel;
  assessedAt: number; // unix ms
}

export interface RiskScorerConfig {
  weights: {
    pegStability: number;
    liquidityDepth: number;
    reserveUtilization: number;
    tvlProtocol: number;
    borrowRateVol: number;
    collateralType: number;
  };
  /** Max peg deviation bps for full score (default 200) */
  maxDeviationBps: number;
  /** Max slippage bps for full score (default 100) */
  maxSlippageBps: number;
  /** Utilization level considered critical (default 0.9) */
  criticalUtilization: number;
  /** TVL in USD below which risk increases linearly (default 10_000_000) */
  tvlSafeThreshold: number;
  /** Max borrow rate stddev for full score (default 0.05) */
  maxBorrowVol: number;
  /** Composite score above which candidate is rejected (default 90) */
  rejectThreshold: number;
  /** Composite score above which emergency deleverage triggers (default 85) */
  emergencyThreshold: number;
  /** EMA smoothing alpha (default 0.3) */
  emaSmoothingAlpha: number;
}

// Candidate market for Multiply market scanner
export interface MultiplyCandidate {
  market: string;
  collToken: string;
  debtToken: string;
  label: string;
  /** @deprecated Use RiskScorer for dynamic risk assessment */
  riskTier?: 1 | 2 | 3;
  collDecimals?: number;
  debtDecimals?: number;
  /** Native yield of collateral (e.g. 0.045 = 4.5% for RWA tokens) */
  collNativeYield?: number;
  /** Minimum TVL in USD to consider this market safe */
  minTvlUsdc?: number;
  /** Target health rate for leverage calculation */
  targetHealthRate?: number;
  alertHealthRate?: number;
  emergencyHealthRate?: number;
  claimRewards?: boolean;
  /** Token held in wallet (e.g. USDC). Auto-swaps to/from collToken if different */
  inputToken?: string;
  inputDecimals?: number;
}

export interface MultiplyRebalanceConfig {
  /** Minimum APY difference (bps) to trigger switch (default 100) */
  minDiffBps: number;
  /** Minimum days to hold before switching (default 3) */
  minHoldingDays: number;
  /** Scan interval in ms (default 21600000 = 6h) */
  scanIntervalMs: number;
  /** @deprecated Use RiskScorer for dynamic risk penalty */
  riskPenalty?: [number, number, number];
  /** Default target health rate for candidates (default 1.15) */
  defaultTargetHealthRate: number;
  /** Default alert health rate (default 1.10) */
  defaultAlertHealthRate: number;
  /** Default emergency health rate (default 1.05) */
  defaultEmergencyHealthRate: number;
}

// Price data
export interface PriceData {
  sol: number;
  dawnsol: number;
  timestamp: number;
}

// Health status
export interface HealthStatus {
  binanceRest: boolean;
  binanceWs: boolean;
  solanaRpc: boolean;
  lastHeartbeat: number;
  uptime: number;
  memoryUsageMb: number;
}
