export type AdvisorCategory =
  | 'rebalance'
  | 'dn_entry'
  | 'dn_exit'
  | 'risk_alert'
  | 'param_adjust';

export type Confidence = 'high' | 'medium' | 'low';
export type Urgency = 'immediate' | 'next_cycle' | 'informational';

export interface AdvisorRecommendation {
  timestamp: number;
  category: AdvisorCategory;
  action: string;
  reasoning: string;
  confidence: Confidence;
  urgency: Urgency;
  currentRule: string;
  override: boolean;
}

export interface AdvisorContext {
  // Position state
  botState: string;
  totalNavUsdc: number;
  lendingBalance: number;
  lendingBreakdown: Record<string, number>;
  multiplyBalance: number;
  multiplyBreakdown: Record<string, number>;
  bufferUsdcBalance: number;

  // Funding rate
  latestFrAnnualized: number;
  avgFr3d: number;
  avgFr7d: number;
  daysAboveEntry: number;
  daysBelowExit: number;
  frHistory24h: Array<{ time: string; annualized: number }>;

  // APY
  lendingApys: Record<string, number>;
  multiplyApys: Record<string, number>;

  // Risk
  riskAssessments: Array<{
    label: string;
    compositeScore: number;
    dimensions: Record<string, number>;
    alertLevel: string;
  }>;

  // Health
  multiplyHealthRates: Record<string, number>;

  // Recent events
  recentEvents: Array<{
    timestamp: string;
    type: string;
    amount: number;
    asset: string;
    protocol?: string;
  }>;

  // Daily PnL
  dailyPnl: {
    dailyReturn: number;
    cumulativeReturn: number;
    maxDrawdown: number;
  } | null;

  // Market data
  solPrice: number;

  // Config thresholds (so AI knows what rules are in effect)
  thresholds: {
    frEntryAnnualized: number;
    frEntryConfirmationDays: number;
    frExitAnnualized: number;
    frExitConfirmationDays: number;
    frEmergencyAnnualized: number;
    lendingRebalanceMinDiffBps: number;
    dailyLossLimitPct: number;
    maxPositionCapUsd: number;
  };
}

export interface AdvisorConfig {
  /** Interval between periodic evaluations in ms (default 21600000 = 6h) */
  intervalMs: number;
  /** Price change threshold to trigger event-based evaluation (default 0.05 = 5%) */
  priceChangeThresholdPct: number;
  /** Maximum API calls per day to manage cost (default 20) */
  maxCallsPerDay: number;
  /** Model to use (default 'claude-sonnet-4-6-20250514') */
  model: string;
  /** Max output tokens (default 1024) */
  maxTokens: number;
  /** Whether to send notifications for recommendations (default true) */
  notifyEnabled: boolean;
}
