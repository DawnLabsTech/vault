import { getDb } from './db.js';
import { getEvents } from './events.js';
import { getSnapshots } from './snapshots.js';
import { calcSharpeRatio, calcMaxDrawdown, round } from '../utils/math.js';
import { EventType } from '../types.js';
import type { DailyPnL } from '../types.js';
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

export function calculateDailyPnl(date: string): DailyPnL {
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

  // Get events for the day
  const dayEvents = getEvents({ from: dayStart, to: dayEnd });

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

  // Daily return
  const dailyReturn = startingNav > 0
    ? round((endingNav - startingNav) / startingNav, 8)
    : 0;

  // Cumulative return from the very first snapshot
  const firstSnapshotRow = getDb().prepare(
    'SELECT total_nav_usdc FROM snapshots ORDER BY timestamp ASC LIMIT 1'
  ).get() as { total_nav_usdc: number } | undefined;

  const initialNav = firstSnapshotRow?.total_nav_usdc ?? startingNav;
  const cumulativeReturn = initialNav > 0
    ? round((endingNav - initialNav) / initialNav, 8)
    : 0;

  // Max drawdown from all historical daily NAVs up to and including today
  const allPnlRows = getDb().prepare(
    'SELECT ending_nav FROM daily_pnl WHERE date <= @date ORDER BY date ASC'
  ).all({ date }) as { ending_nav: number }[];

  const navSeries = allPnlRows.map(r => r.ending_nav);
  navSeries.push(endingNav); // include today
  const maxDrawdown = calcMaxDrawdown(navSeries);

  const pnl: DailyPnL = {
    date,
    startingNav: round(startingNav, 4),
    endingNav: round(endingNav, 4),
    dailyReturn,
    cumulativeReturn,
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
    maxDrawdown: round(maxDrawdown, 6),
  };

  log.info({ date, dailyReturn: pnl.dailyReturn, endingNav: pnl.endingNav }, 'Daily PnL calculated');
  return pnl;
}

export function saveDailyPnl(pnl: DailyPnL): void {
  const stmt = getUpsertStmt();
  stmt.run(pnl);
  log.debug({ date: pnl.date }, 'Daily PnL saved');
}

export function getDailyPnlRange(from: string, to: string): DailyPnL[] {
  const rows = getRangeStmt().all({ from, to }) as Record<string, unknown>[];
  return rows.map(rowToPnl);
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

export function getPerformanceSummary(): PerformanceSummary {
  const allRows = allNoParams(getAllStmt()) as Record<string, unknown>[];
  const allPnl = allRows.map(rowToPnl);

  // Calculate today's live PnL from snapshots/events
  const todayStr = new Date().toISOString().split('T')[0]!;
  const lastSavedDate = allPnl.length > 0 ? allPnl[allPnl.length - 1]!.date : null;

  // Only add today's live data if it hasn't been saved yet
  if (lastSavedDate !== todayStr) {
    try {
      const todayPnl = calculateDailyPnl(todayStr);
      // Only include if we have meaningful snapshot data
      if (todayPnl.startingNav > 0 || todayPnl.endingNav > 0) {
        allPnl.push(todayPnl);
      }
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to calculate live daily PnL');
    }
  }

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

  const firstNav = validPnl[0]!.startingNav;
  const lastNav = validPnl[validPnl.length - 1]!.endingNav;
  const totalReturn = firstNav > 0 ? (lastNav - firstNav) / firstNav : 0;

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

  const unrealizedPnl = lastNav - firstNav;

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
