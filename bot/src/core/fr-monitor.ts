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

  /** Track last recorded funding time to deduplicate WebSocket events. */
  private lastRecordedFundingTime: number = 0;

  /** Record a new funding rate data point. Deduplicates by fundingTime (rounded to nearest hour). */
  recordFundingRate(data: FundingRateData): void {
    // Round to nearest hour to handle ms-level jitter (e.g. 00:00:00.000Z vs 00:00:00.008Z)
    const roundedTime = Math.round(data.fundingTime / 3_600_000) * 3_600_000;

    // Skip if we already recorded this funding period (in-memory dedup)
    if (roundedTime === this.lastRecordedFundingTime) {
      return;
    }

    const annualized = frToAnnualized(data.fundingRate, this.periodsPerDay);
    const ts = new Date(roundedTime).toISOString();

    // DB-level dedup: check if this hour already exists
    const existing = this.db
      .prepare("SELECT id FROM fr_history WHERE timestamp >= ? AND timestamp < ? LIMIT 1")
      .get(
        new Date(roundedTime).toISOString(),
        new Date(roundedTime + 3_600_000).toISOString(),
      ) as { id: number } | undefined;
    if (existing) {
      this.lastRecordedFundingTime = roundedTime;
      return;
    }

    this.insertStmt.run(
      ts,
      data.symbol,
      data.fundingRate,
      annualized,
      data.markPrice ?? null,
    );

    this.lastRecordedFundingTime = roundedTime;

    log.info(
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
   * Only full days are counted; a day becomes valid once all expected FR samples arrive.
   */
  getAverageAnnualized(days: number): number {
    const completeDays = this.getDailySummaries()
      .filter((row) => row.sampleCount >= this.periodsPerDay)
      .slice(0, days);

    if (completeDays.length === 0) return 0;

    const avg =
      completeDays.reduce((sum, row) => sum + row.avgRate, 0) / completeDays.length;
    return avg;
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
   * 1. Group FR records by UTC date.
   * 2. Ignore the current partial day until all expected FR samples arrive.
   * 3. After the streak starts, each prior UTC day must be complete and contiguous.
   * 4. For "above": the day qualifies if MIN(annualized_rate) > threshold.
   * 5. For "below": the day qualifies if MAX(annualized_rate) < threshold.
   */
  private countConsecutiveDays(
    thresholdAnnualized: number,
    direction: 'above' | 'below',
  ): number {
    const rows = this.getDailySummaries();

    let count = 0;
    let lastQualifiedDay: string | null = null;

    for (const row of rows) {
      if (lastQualifiedDay === null && row.sampleCount < this.periodsPerDay) {
        continue;
      }

      if (row.sampleCount < this.periodsPerDay) {
        break;
      }

      if (
        lastQualifiedDay !== null &&
        row.day !== previousUtcDate(lastQualifiedDay)
      ) {
        break;
      }

      const qualifies =
        direction === 'above'
          ? row.minRate > thresholdAnnualized
          : row.maxRate < thresholdAnnualized;

      if (qualifies) {
        count++;
        lastQualifiedDay = row.day;
      } else {
        break;
      }
    }

    return count;
  }

  private getDailySummaries(): DailyFrSummary[] {
    return this.db
      .prepare(
        `SELECT
           DATE(timestamp) AS day,
           COUNT(*) AS sampleCount,
           MIN(annualized_rate) AS minRate,
           MAX(annualized_rate) AS maxRate,
           AVG(annualized_rate) AS avgRate
         FROM fr_history
         GROUP BY DATE(timestamp)
         ORDER BY day DESC`,
      )
      .all() as DailyFrSummary[];
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

interface DailyFrSummary {
  day: string;
  sampleCount: number;
  minRate: number;
  maxRate: number;
  avgRate: number;
}

function rowToData(row: FrRow): FundingRateData {
  return {
    symbol: row.symbol,
    fundingRate: row.funding_rate,
    fundingTime: new Date(row.timestamp).getTime(),
    markPrice: row.mark_price ?? undefined,
  };
}

function previousUtcDate(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
