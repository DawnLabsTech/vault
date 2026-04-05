import { getDb } from './db.js';
import type { PortfolioSnapshot, BotState } from '../types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('snapshots');

let stmtInsert: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let stmtLatest: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;

function getInsertStmt() {
  if (!stmtInsert) {
    stmtInsert = getDb().prepare(`
      INSERT INTO snapshots (
        timestamp, total_nav_usdc, lending_balance, lending_breakdown,
        multiply_balance, multiply_breakdown,
        dawnsol_balance, dawnsol_usdc_value, binance_usdc_balance,
        buffer_usdc_balance, binance_perp_unrealized_pnl, binance_perp_size,
        state, sol_price, dawnsol_price
      ) VALUES (
        @timestamp, @totalNavUsdc, @lendingBalance, @lendingBreakdown,
        @multiplyBalance, @multiplyBreakdown,
        @dawnsolBalance, @dawnsolUsdcValue, @binanceUsdcBalance,
        @bufferUsdcBalance, @binancePerpUnrealizedPnl, @binancePerpSize,
        @state, @solPrice, @dawnsolPrice
      )
    `);
  }
  return stmtInsert;
}

function getLatestStmt() {
  if (!stmtLatest) {
    stmtLatest = getDb().prepare('SELECT * FROM snapshots ORDER BY timestamp DESC LIMIT 1');
  }
  return stmtLatest;
}

// Helper to run parameterless prepared statements
function getNoParams(stmt: ReturnType<ReturnType<typeof getDb>['prepare']>) {
  return (stmt as unknown as { get(): unknown }).get();
}

function snapshotToRow(snapshot: PortfolioSnapshot) {
  return {
    timestamp: snapshot.timestamp,
    totalNavUsdc: snapshot.totalNavUsdc,
    lendingBalance: snapshot.lendingBalance,
    lendingBreakdown: JSON.stringify(snapshot.lendingBreakdown),
    multiplyBalance: snapshot.multiplyBalance,
    multiplyBreakdown: JSON.stringify(snapshot.multiplyBreakdown),
    dawnsolBalance: snapshot.dawnsolBalance,
    dawnsolUsdcValue: snapshot.dawnsolUsdcValue,
    binanceUsdcBalance: snapshot.binanceUsdcBalance,
    bufferUsdcBalance: snapshot.bufferUsdcBalance,
    binancePerpUnrealizedPnl: snapshot.binancePerpUnrealizedPnl,
    binancePerpSize: snapshot.binancePerpSize,
    state: snapshot.state,
    solPrice: snapshot.solPrice,
    dawnsolPrice: snapshot.dawnsolPrice,
  };
}

function rowToSnapshot(row: Record<string, unknown>): PortfolioSnapshot {
  return {
    timestamp: row['timestamp'] as string,
    totalNavUsdc: row['total_nav_usdc'] as number,
    lendingBalance: row['lending_balance'] as number,
    lendingBreakdown: JSON.parse((row['lending_breakdown'] as string) || '{}') as Record<string, number>,
    multiplyBalance: (row['multiply_balance'] as number) ?? 0,
    multiplyBreakdown: JSON.parse((row['multiply_breakdown'] as string) || '{}') as Record<string, number>,
    dawnsolBalance: row['dawnsol_balance'] as number,
    dawnsolUsdcValue: row['dawnsol_usdc_value'] as number,
    binanceUsdcBalance: row['binance_usdc_balance'] as number,
    bufferUsdcBalance: row['buffer_usdc_balance'] as number,
    binancePerpUnrealizedPnl: row['binance_perp_unrealized_pnl'] as number,
    binancePerpSize: row['binance_perp_size'] as number,
    state: row['state'] as BotState,
    solPrice: row['sol_price'] as number,
    dawnsolPrice: row['dawnsol_price'] as number,
  };
}

export function recordSnapshot(snapshot: PortfolioSnapshot): void {
  const stmt = getInsertStmt();
  stmt.run(snapshotToRow(snapshot));
  log.debug({ nav: snapshot.totalNavUsdc, state: snapshot.state }, 'Snapshot recorded');
}

export function getLatestSnapshot(): PortfolioSnapshot | null {
  const row = getNoParams(getLatestStmt()) as Record<string, unknown> | undefined;
  return row ? rowToSnapshot(row) : null;
}

export interface GetSnapshotsOptions {
  from?: string;
  to?: string;
  limit?: number;
}

export function getSnapshots(opts: GetSnapshotsOptions): PortfolioSnapshot[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts.from) {
    conditions.push('timestamp >= @from');
    params['from'] = opts.from;
  }
  if (opts.to) {
    conditions.push('timestamp <= @to');
    params['to'] = opts.to;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  if (opts.limit) {
    params['limit'] = opts.limit;
  }
  const limitClause = opts.limit ? 'LIMIT @limit' : '';

  const sql = `SELECT * FROM snapshots ${where} ORDER BY timestamp ASC ${limitClause}`;
  const rows = getDb().prepare(sql).all(params) as Record<string, unknown>[];
  return rows.map(rowToSnapshot);
}

export function getDailyCloseSnapshots(days: number): PortfolioSnapshot[] {
  // Get the snapshot closest to UTC 00:00 for each day, looking at the last N days
  // We find the snapshot with the minimum absolute time difference from midnight for each date
  const sql = `
    WITH daily AS (
      SELECT *,
        DATE(timestamp) as snap_date,
        ABS(
          (CAST(strftime('%H', timestamp) AS INTEGER) * 3600 +
           CAST(strftime('%M', timestamp) AS INTEGER) * 60 +
           CAST(strftime('%S', timestamp) AS INTEGER))
        ) as seconds_from_midnight,
        ROW_NUMBER() OVER (
          PARTITION BY DATE(timestamp)
          ORDER BY ABS(
            CAST(strftime('%H', timestamp) AS INTEGER) * 3600 +
            CAST(strftime('%M', timestamp) AS INTEGER) * 60 +
            CAST(strftime('%S', timestamp) AS INTEGER)
          ) ASC
        ) as rn
      FROM snapshots
      WHERE timestamp >= datetime('now', @daysOffset)
    )
    SELECT * FROM daily WHERE rn = 1 ORDER BY snap_date ASC
  `;

  const rows = getDb().prepare(sql).all({ daysOffset: `-${days} days` }) as Record<string, unknown>[];
  return rows.map(rowToSnapshot);
}
