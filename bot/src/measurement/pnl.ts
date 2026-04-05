import { getDb } from './db.js';
import { getEvents } from './events.js';
import { getSnapshots } from './snapshots.js';
import { calcSharpeRatio, calcMaxDrawdown, round } from '../utils/math.js';
import { EventType } from '../types.js';
import type { DailyPnL, LedgerEvent, PortfolioSnapshot } from '../types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('pnl');

let stmtUpsert: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let stmtGetRange: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let stmtGetAll: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;

function getUpsertStmt() {
  if (!stmtUpsert) {
    stmtUpsert = getDb().prepare(`
      INSERT OR REPLACE INTO daily_pnl (
        date, starting_nav, ending_nav, daily_return, cumulative_return,
        realized_pnl, unrealized_pnl, lending_interest, funding_received,
        funding_paid, staking_accrual, swap_pnl, binance_trading_fee,
        binance_withdraw_fee, solana_gas, swap_slippage, lending_fee,
        total_fees, nav_high, nav_low, max_drawdown
      ) VALUES (
        @date, @startingNav, @endingNav, @dailyReturn, @cumulativeReturn,
        @realizedPnl, @unrealizedPnl, @lendingInterest, @fundingReceived,
        @fundingPaid, @stakingAccrual, @swapPnl, @binanceTradingFee,
        @binanceWithdrawFee, @solanaGas, @swapSlippage, @lendingFee,
        @totalFees, @navHigh, @navLow, @maxDrawdown
      )
    `);
  }
  return stmtUpsert;
}

function getRangeStmt() {
  if (!stmtGetRange) {
    stmtGetRange = getDb().prepare(
      'SELECT * FROM daily_pnl WHERE date >= @from AND date <= @to ORDER BY date ASC'
    );
  }
  return stmtGetRange;
}

function getAllStmt() {
  if (!stmtGetAll) {
    stmtGetAll = getDb().prepare('SELECT * FROM daily_pnl ORDER BY date ASC');
  }
  return stmtGetAll;
}

// Helper to run parameterless prepared statements
function allNoParams(stmt: ReturnType<ReturnType<typeof getDb>['prepare']>) {
  return (stmt as unknown as { all(): unknown[] }).all();
}

function rowToPnl(row: Record<string, unknown>): DailyPnL {
  return {
    date: row['date'] as string,
    startingNav: row['starting_nav'] as number,
    endingNav: row['ending_nav'] as number,
    dailyReturn: row['daily_return'] as number,
    cumulativeReturn: row['cumulative_return'] as number,
    realizedPnl: row['realized_pnl'] as number,
    unrealizedPnl: row['unrealized_pnl'] as number,
    lendingInterest: row['lending_interest'] as number,
    fundingReceived: row['funding_received'] as number,
    fundingPaid: row['funding_paid'] as number,
    stakingAccrual: row['staking_accrual'] as number,
    swapPnl: row['swap_pnl'] as number,
    binanceTradingFee: row['binance_trading_fee'] as number,
    binanceWithdrawFee: row['binance_withdraw_fee'] as number,
    solanaGas: row['solana_gas'] as number,
    swapSlippage: row['swap_slippage'] as number,
    lendingFee: row['lending_fee'] as number,
    totalFees: row['total_fees'] as number,
    navHigh: row['nav_high'] as number,
    navLow: row['nav_low'] as number,
    maxDrawdown: row['max_drawdown'] as number,
  };
}

function createEmptyDailyPnl(date: string): DailyPnL {
  return {
    date,
    startingNav: 0,
    endingNav: 0,
    dailyReturn: 0,
    cumulativeReturn: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    lendingInterest: 0,
    fundingReceived: 0,
    fundingPaid: 0,
    stakingAccrual: 0,
    swapPnl: 0,
    binanceTradingFee: 0,
    binanceWithdrawFee: 0,
    solanaGas: 0,
    swapSlippage: 0,
    lendingFee: 0,
    totalFees: 0,
    navHigh: 0,
    navLow: 0,
    maxDrawdown: 0,
  };
}

function getSnapshotDates(from: string, to: string): string[] {
  const rows = getDb().prepare(`
    SELECT DISTINCT DATE(timestamp) as date
    FROM snapshots
    WHERE DATE(timestamp) >= DATE(@from) AND DATE(timestamp) <= DATE(@to)
    ORDER BY DATE(timestamp) ASC
  `).all({ from, to }) as { date: string }[];

  return rows.map((row) => row.date);
}

function getWalletUsdcInternalFlow(events: LedgerEvent[]): number {
  let netFlow = 0;

  for (const event of events) {
    const action = event.metadata?.['action'];
    const amount = event.amount ?? 0;
    if (typeof action !== 'string' || amount === 0) continue;

    switch (action) {
      case 'rebalance_withdraw':
      case 'dn_entry_withdraw_lending':
      case 'capital_rebalance_multiply_withdraw':
      case 'multiply_market_switch_withdraw':
      case 'soft_deleverage':
      case 'risk_soft_deleverage':
        netFlow += amount;
        break;

      case 'rebalance_deposit':
      case 'dn_exit_deposit_lending':
      case 'capital_rebalance_multiply_deposit':
      case 'multiply_market_switch_deposit':
      case 'dn_entry_transfer_margin_to_binance':
        netFlow -= amount;
        break;

      case 'dn_entry_swap_usdc_dawnsol': {
        const usdcSpent = event.metadata?.['usdcSpent'];
        if (typeof usdcSpent === 'number') {
          netFlow -= usdcSpent;
        }
        break;
      }

      case 'dn_exit_swap_sol_usdc':
        netFlow += amount;
        break;

      default:
        break;
    }
  }

  return round(netFlow, 6);
}

/**
 * Detect external deposits/withdrawals by looking for large NAV jumps between
 * consecutive snapshots. Organic market moves are small (< a few %) per
 * snapshot interval (~5 min), so any jump exceeding the threshold is classified
 * as an external cash flow.
 *
 * This replaces the previous buffer-delta + event-based approach, which was
 * brittle when compound operations (swap → deposit → leverage) partially
 * failed — the event was logged as "_failed" even though USDC already left
 * the buffer, causing the flow estimate to be wildly off.
 */
export function estimateExternalUsdcFlow(
  snapshots: PortfolioSnapshot[],
  _events: LedgerEvent[],
): number {
  if (snapshots.length < 2) return 0;

  // Absolute NAV change threshold per snapshot interval to classify as
  // external flow. Organic moves between 5-min snapshots are typically
  // < $1 for a sub-$10k portfolio.
  const JUMP_THRESHOLD_USD = 5;

  let totalExternalFlow = 0;
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!;
    const curr = snapshots[i]!;
    if (prev.totalNavUsdc <= 0) continue;

    const delta = curr.totalNavUsdc - prev.totalNavUsdc;
    if (Math.abs(delta) > JUMP_THRESHOLD_USD) {
      totalExternalFlow += delta;
    }
  }

  return round(totalExternalFlow, 6);
}

function calculateDailyPnlForDate(date: string): DailyPnL {
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;

  // Get start and end snapshots for the day
  const daySnapshots = getSnapshots({ from: dayStart, to: dayEnd });

  const startSnapshot = daySnapshots[0];
  const endSnapshot = daySnapshots[daySnapshots.length - 1];

  const startingNav = startSnapshot?.totalNavUsdc ?? 0;
  const endingNav = endSnapshot?.totalNavUsdc ?? 0;

  // NAV high/low from intraday snapshots
  let navHigh = startingNav;
  let navLow = startingNav;
  for (const snap of daySnapshots) {
    if (snap.totalNavUsdc > navHigh) navHigh = snap.totalNavUsdc;
    if (snap.totalNavUsdc < navLow) navLow = snap.totalNavUsdc;
  }

  // Only attribute flows and PnL events that occur within the observed snapshot window.
  // This prevents post-snapshot rebalance events from distorting the day's return.
  const eventWindowStart = startSnapshot?.timestamp ?? dayStart;
  const eventWindowEnd = endSnapshot?.timestamp ?? dayEnd;
  const dayEvents = getEvents({ from: eventWindowStart, to: eventWindowEnd });
  const netExternalFlow = estimateExternalUsdcFlow(daySnapshots, dayEvents);

  // Revenue aggregation
  let lendingInterest = 0;
  let fundingReceived = 0;
  let fundingPaid = 0;
  let stakingAccrual = 0;
  let swapPnl = 0;
  let realizedPnl = 0;

  // Fee aggregation
  let binanceTradingFee = 0;
  let binanceWithdrawFee = 0;
  let solanaGas = 0;
  let swapSlippage = 0;
  let lendingFee = 0;

  for (const event of dayEvents) {
    const fee = event.fee ?? 0;
    const amount = event.amount;

    switch (event.eventType) {
      case EventType.LENDING_INTEREST:
        lendingInterest += amount;
        realizedPnl += amount;
        break;

      case EventType.FR_PAYMENT:
        if (amount >= 0) {
          fundingReceived += amount;
          realizedPnl += amount;
        } else {
          fundingPaid += Math.abs(amount);
          realizedPnl += amount; // negative
        }
        break;

      case EventType.SWAP:
        swapPnl += amount;
        realizedPnl += amount;
        // Extract slippage from metadata if present
        if (event.metadata?.['slippage'] != null) {
          swapSlippage += Math.abs(event.metadata['slippage'] as number);
        }
        break;

      case EventType.PERP_CLOSE:
        realizedPnl += amount;
        break;

      case EventType.STATE_CHANGE:
        // Staking accrual is tracked via metadata
        if (event.metadata?.['stakingAccrual'] != null) {
          stakingAccrual += event.metadata['stakingAccrual'] as number;
          realizedPnl += event.metadata['stakingAccrual'] as number;
        }
        break;

      default:
        break;
    }

    // Categorize fees by source protocol
    if (fee > 0) {
      const source = event.sourceProtocol ?? '';
      if (source === 'binance') {
        if (event.eventType === EventType.TRANSFER || event.eventType === EventType.WITHDRAW) {
          binanceWithdrawFee += fee;
        } else {
          binanceTradingFee += fee;
        }
      } else if (source === 'solana' || event.feeAsset === 'SOL') {
        solanaGas += fee;
      } else {
        lendingFee += fee;
      }
    }
  }

  const totalFees = binanceTradingFee + binanceWithdrawFee + solanaGas + swapSlippage + lendingFee;
  const unrealizedPnl = endSnapshot
    ? endSnapshot.binancePerpUnrealizedPnl
    : 0;

  // Daily return excluding external wallet top-ups / withdrawals.
  const dailyReturn = startingNav > 0
    ? round((endingNav - startingNav - netExternalFlow) / startingNav, 8)
    : 0;

  const pnl: DailyPnL = {
    date,
    startingNav: round(startingNav, 4),
    endingNav: round(endingNav, 4),
    dailyReturn,
    cumulativeReturn: 0,
    realizedPnl: round(realizedPnl, 4),
    unrealizedPnl: round(unrealizedPnl, 4),
    lendingInterest: round(lendingInterest, 4),
    fundingReceived: round(fundingReceived, 4),
    fundingPaid: round(fundingPaid, 4),
    stakingAccrual: round(stakingAccrual, 4),
    swapPnl: round(swapPnl, 4),
    binanceTradingFee: round(binanceTradingFee, 4),
    binanceWithdrawFee: round(binanceWithdrawFee, 4),
    solanaGas: round(solanaGas, 4),
    swapSlippage: round(swapSlippage, 4),
    lendingFee: round(lendingFee, 4),
    totalFees: round(totalFees, 4),
    navHigh: round(navHigh, 4),
    navLow: round(navLow, 4),
    maxDrawdown: 0,
  };

  log.info(
    {
      date,
      dailyReturn: pnl.dailyReturn,
      endingNav: pnl.endingNav,
      netExternalFlow,
    },
    'Daily PnL calculated',
  );
  return pnl;
}

function finalizePnlSeries(rows: DailyPnL[]): DailyPnL[] {
  let cumulativeGrowth = 1;
  const navSeries: number[] = [];

  return rows.map((row) => {
    cumulativeGrowth *= 1 + row.dailyReturn;
    navSeries.push(row.endingNav);
    return {
      ...row,
      cumulativeReturn: round(cumulativeGrowth - 1, 8),
      maxDrawdown: round(calcMaxDrawdown(navSeries), 6),
    };
  });
}

export function calculateDailyPnl(date: string): DailyPnL {
  const rows = getDailyPnlRange('0000-01-01', date);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.date === date) {
      return rows[i]!;
    }
  }
  return createEmptyDailyPnl(date);
}

export function saveDailyPnl(pnl: DailyPnL): void {
  const stmt = getUpsertStmt();
  stmt.run(pnl);
  log.debug({ date: pnl.date }, 'Daily PnL saved');
}

export function getDailyPnlRange(from: string, to: string): DailyPnL[] {
  const snapshotDates = getSnapshotDates(from, to);
  if (snapshotDates.length === 0) {
    const rows = getRangeStmt().all({ from, to }) as Record<string, unknown>[];
    return rows.map(rowToPnl);
  }

  const computed = snapshotDates.map((date) => calculateDailyPnlForDate(date));
  return finalizePnlSeries(computed);
}

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

/**
 * Compute total invested capital (Money-Weighted basis).
 *
 * investedCapital = first day's startingNav (initial deposit)
 *                 + sum of all detected external inflows across days.
 *
 * External flows are detected per-day using the NAV-jump method in
 * estimateExternalUsdcFlow.  Positive flow = deposit, negative = withdrawal.
 */
function computeInvestedCapital(validPnl: DailyPnL[]): number {
  if (validPnl.length === 0) return 0;

  let invested = validPnl[0]!.startingNav; // initial capital

  for (const day of validPnl) {
    // Re-derive external flow for this day from the PnL row:
    // dailyReturn = (endNav - startNav - flow) / startNav
    //  => flow = endNav - startNav - dailyReturn * startNav
    if (day.startingNav > 0) {
      const flow = round(day.endingNav - day.startingNav - day.dailyReturn * day.startingNav, 6);
      if (flow > 0) invested += flow;   // deposit
      // withdrawals reduce invested capital
      if (flow < 0) invested = Math.max(invested + flow, 0.01);
    }
  }
  return invested;
}

export function getPerformanceSummary(): PerformanceSummary {
  const allPnl = getDailyPnlRange('0000-01-01', '9999-12-31');

  // Filter out days with no meaningful NAV data (e.g. bot started mid-day)
  const validPnl = allPnl.filter(p => p.startingNav > 0 && p.endingNav > 0);

  if (validPnl.length === 0) {
    return {
      totalReturn: 0,
      annualizedReturn: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      totalDays: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalFees: 0,
    };
  }

  const totalDays = validPnl.length;
  const dailyReturns = validPnl.map(p => p.dailyReturn);

  // Money-weighted return: (currentNAV - totalInvested) / totalInvested
  const currentNav = validPnl[validPnl.length - 1]!.endingNav;
  const investedCapital = computeInvestedCapital(validPnl);
  const totalReturn = investedCapital > 0
    ? (currentNav - investedCapital) / investedCapital
    : 0;

  // Annualized return: (1 + totalReturn)^(365/days) - 1
  // Only annualize when we have >= 7 days of data to avoid misleading extrapolation
  const annualizedReturn = totalDays >= 7
    ? Math.pow(1 + totalReturn, 365 / totalDays) - 1
    : 0;

  const sharpeRatio = calcSharpeRatio(dailyReturns);

  const navSeries = validPnl.map(p => p.endingNav);
  const maxDrawdown = calcMaxDrawdown(navSeries);

  // Cumulative realized PnL and fees (use allPnl to include all days)
  const realizedPnl = allPnl.reduce((sum, p) => sum + p.realizedPnl, 0);
  const totalFees = allPnl.reduce((sum, p) => sum + p.totalFees, 0);
  // Note: realizedPnl/totalFees use allPnl (not validPnl) since fee/revenue
  // events can occur on days without full NAV snapshots

  const unrealizedPnl = validPnl[validPnl.length - 1]!.unrealizedPnl;

  return {
    totalReturn: round(totalReturn, 6),
    annualizedReturn: round(annualizedReturn, 6),
    sharpeRatio: round(sharpeRatio, 4),
    maxDrawdown: round(maxDrawdown, 6),
    totalDays,
    realizedPnl: round(realizedPnl, 4),
    unrealizedPnl: round(unrealizedPnl, 4),
    totalFees: round(totalFees, 4),
  };
}
