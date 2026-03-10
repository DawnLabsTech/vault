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

// Lending Protocol Interface
export interface LendingProtocol {
  name: string;
  getApy(): Promise<number>;
  getBalance(): Promise<number>;
  deposit(amount: number): Promise<string>; // returns tx sig
  withdraw(amount: number): Promise<string>;
}

// Config
export type PerpExchange = 'binance' | 'drift';

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
