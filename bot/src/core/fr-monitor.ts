import type Database from 'better-sqlite3';
import type { FundingRateData } from '../types.js';
import { frToAnnualized } from '../utils/math.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('fr-monitor');

/**
 * Funding Rate monitor — records FR data, provides aggregated queries.
 *
 * Uses the `fr_history` table in SQLite:
 *   id, timestamp (ISO), symbol, funding_rate, annualized_rate, mark_price
 *
 * FR arrives every 8 hours → 3 records per day.
 */
export class FrMonitor {
  private insertStmt: Database.Statement;
  private db: Database.Database;
  private periodsPerDay: number;

  constructor(db: Database.Database, periodsPerDay = 3) {
    this.db = db;
    this.periodsPerDay = periodsPerDay;

    // Prepared statements for hot-path operations
    this.insertStmt = db.prepare(`
      INSERT INTO fr_history (timestamp, symbol, funding_rate, annualized_rate, mark_price)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  // ── Write ────────────────────────────────────────────────

  /** Record a new funding rate data point. */
  recordFundingRate(data: FundingRateData): void {
    const annualized = frToAnnualized(data.fundingRate, this.periodsPerDay);
    const ts = new Date(data.fundingTime).toISOString();

    this.insertStmt.run(
      ts,
      data.symbol,
      data.fundingRate,
      annualized,
      data.markPrice ?? null,
    );

    log.debug(
      { symbol: data.symbol, fr: data.fundingRate, annualized: annualized.toFixed(2) },
      'Recorded funding rate',
    );
  }

  // ── Read ─────────────────────────────────────────────────

  /** Return the most recently recorded FR entry, or null if none. */
  getLatestRate(): FundingRateData | null {
    const row = this.db
      .prepare('SELECT * FROM fr_history ORDER BY timestamp DESC LIMIT 1')
      .get() as FrRow | undefined;

    return row ? rowToData(row) : null;
  }

  /** Latest FR expressed as annualized percentage. Returns 0 if no data. */
  getLatestAnnualized(): number {
    const row = this.db
      .prepare('SELECT annualized_rate FROM fr_history ORDER BY timestamp DESC LIMIT 1')
      .get() as { annualized_rate: number } | undefined;

    return row?.annualized_rate ?? 0;
  }

  /**
   * Average annualized FR over the last `days` days.
   * Records per day depends on exchange (3 for 8h Binance, 24 for 1h Drift).
   */
  getAverageAnnualized(days: number): number {
    const limit = days * this.periodsPerDay;
    const row = this.db
      .prepare(
        `SELECT AVG(annualized_rate) AS avg_rate
         FROM (
           SELECT annualized_rate FROM fr_history
           ORDER BY timestamp DESC
           LIMIT ?
         )`,
      )
      .get(limit) as { avg_rate: number | null } | undefined;

    return row?.avg_rate ?? 0;
  }

  /**
   * Count consecutive days (from today backwards) where **all 3 daily FRs**
   * are above the given annualized threshold.
   *
   * Groups records by UTC date, checks that every FR in each day exceeds the
   * threshold, and counts consecutive qualifying days starting from the most recent.
   */
  getDaysAboveThreshold(thresholdAnnualized: number): number {
    return this.countConsecutiveDays(thresholdAnnualized, 'above');
  }

  /**
   * Count consecutive days (from today backwards) where **all 3 daily FRs**
   * are below the given annualized threshold.
   */
  getDaysBelowThreshold(thresholdAnnualized: number): number {
    return this.countConsecutiveDays(thresholdAnnualized, 'below');
  }

  /** Return the most recent `limit` FR records (newest first). */
  getFrHistory(limit: number): FundingRateData[] {
    const rows = this.db
      .prepare('SELECT * FROM fr_history ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as FrRow[];

    return rows.map(rowToData);
  }

  // ── Private helpers ──────────────────────────────────────

  /**
   * Shared logic for consecutive-day counting.
   *
   * Strategy:
   * 1. Group FR records by UTC date, compute MIN or MAX of annualized_rate per day.
   * 2. For "above": the day qualifies if MIN(annualized_rate) > threshold
   *    (i.e. every FR that day was above).
   * 3. For "below": the day qualifies if MAX(annualized_rate) < threshold.
   * 4. Walk days from most recent backwards, counting consecutive qualifying days.
   */
  private countConsecutiveDays(
    thresholdAnnualized: number,
    direction: 'above' | 'below',
  ): number {
    const aggFn = direction === 'above' ? 'MIN' : 'MAX';

    const rows = this.db
      .prepare(
        `SELECT DATE(timestamp) AS day, ${aggFn}(annualized_rate) AS agg_rate
         FROM fr_history
         GROUP BY DATE(timestamp)
         ORDER BY day DESC`,
      )
      .all() as Array<{ day: string; agg_rate: number }>;

    let count = 0;
    for (const row of rows) {
      const qualifies =
        direction === 'above'
          ? row.agg_rate > thresholdAnnualized
          : row.agg_rate < thresholdAnnualized;

      if (qualifies) {
        count++;
      } else {
        break; // streak broken
      }
    }
    return count;
  }
}

// ── Row mapping ──────────────────────────────────────────

interface FrRow {
  id: number;
  timestamp: string;
  symbol: string;
  funding_rate: number;
  annualized_rate: number;
  mark_price: number | null;
}

function rowToData(row: FrRow): FundingRateData {
  return {
    symbol: row.symbol,
    fundingRate: row.funding_rate,
    fundingTime: new Date(row.timestamp).getTime(),
    markPrice: row.mark_price ?? undefined,
  };
}
