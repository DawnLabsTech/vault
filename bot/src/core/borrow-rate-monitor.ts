import type Database from 'better-sqlite3';
import type { BorrowRateSpikeConfig } from '../types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('borrow-rate-monitor');

export interface BorrowRateSnapshot {
  label: string;
  baseBorrowApy: number;
  baseSupplyApy: number;
  effectiveApy: number;
  nativeYield: number;
  leverage: number;
}

export interface SpikeAlert {
  label: string;
  level: 'warning' | 'critical';
  reason: 'absolute_threshold' | 'rate_change' | 'negative_spread';
  message: string;
  currentRate: number;
  rateChangeBps?: number;
}

interface BorrowRateRow {
  id: number;
  timestamp: string;
  label: string;
  base_borrow_apy: number;
  base_supply_apy: number;
  effective_apy: number;
  native_yield: number | null;
  leverage: number | null;
}

/**
 * Borrow Rate monitor — records Kamino Multiply borrow rates and detects spikes.
 *
 * Samples are recorded every 5 minutes (piggybacked on kamino-multiply-health).
 * Spike detection uses three conditions:
 *   1. Absolute threshold: borrow APY exceeds a fixed ceiling
 *   2. Rate of change: borrow APY increased by > N bps in 1 hour
 *   3. Negative spread: effective APY falls below threshold (e.g. 0)
 */
export class BorrowRateMonitor {
  private insertStmt: Database.Statement;
  private db: Database.Database;

  /** Cooldown tracking: label -> { level, timestamp } */
  private lastAlerts = new Map<string, { level: string; timestamp: number }>();
  private static readonly ALERT_COOLDOWN_MS = 1_800_000; // 30 min

  constructor(db: Database.Database) {
    this.db = db;

    this.insertStmt = db.prepare(`
      INSERT INTO borrow_rate_history
        (timestamp, label, base_borrow_apy, base_supply_apy, effective_apy, native_yield, leverage)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  // ── Write ────────────────────────────────────────────────

  /** Record a borrow rate snapshot. Deduplicates by 5-minute window. */
  recordRate(data: BorrowRateSnapshot): void {
    const now = Date.now();
    // Round to 5-minute window
    const windowMs = 5 * 60 * 1000;
    const roundedTime = Math.floor(now / windowMs) * windowMs;
    const ts = new Date(roundedTime).toISOString();

    // Check for existing record in this window
    const existing = this.db
      .prepare('SELECT id FROM borrow_rate_history WHERE label = ? AND timestamp = ? LIMIT 1')
      .get(data.label, ts) as { id: number } | undefined;
    if (existing) return;

    this.insertStmt.run(
      ts,
      data.label,
      data.baseBorrowApy,
      data.baseSupplyApy,
      data.effectiveApy,
      data.nativeYield,
      data.leverage,
    );

    log.debug(
      {
        label: data.label,
        borrowApy: (data.baseBorrowApy * 100).toFixed(2),
        effectiveApy: (data.effectiveApy * 100).toFixed(2),
      },
      'Recorded borrow rate',
    );
  }

  // ── Spike Detection ──────────────────────────────────────

  /** Detect borrow rate spike for a given label. Returns the most severe alert or null. */
  detectSpike(label: string, config: BorrowRateSpikeConfig): SpikeAlert | null {
    const latest = this.getLatestRow(label);
    if (!latest) return null;

    // Check conditions from most severe to least
    // 1. Negative spread (critical)
    if (latest.effective_apy < config.negativeSpreadThreshold) {
      return this.emitIfNotCooledDown(label, {
        label,
        level: 'critical',
        reason: 'negative_spread',
        message: `[${label}] Negative spread detected: effective APY ${(latest.effective_apy * 100).toFixed(2)}% < ${(config.negativeSpreadThreshold * 100).toFixed(2)}%, borrow rate ${(latest.base_borrow_apy * 100).toFixed(2)}%`,
        currentRate: latest.base_borrow_apy,
      });
    }

    // 2. Rate of change (warning)
    const rateChange = this.getRateChangePerHour(label);
    if (rateChange && rateChange.changeBps > config.rateChangeThresholdBps) {
      return this.emitIfNotCooledDown(label, {
        label,
        level: 'warning',
        reason: 'rate_change',
        message: `[${label}] Borrow rate spiking: +${rateChange.changeBps.toFixed(0)} bps/hr (${(rateChange.oldRate * 100).toFixed(2)}% → ${(rateChange.newRate * 100).toFixed(2)}%)`,
        currentRate: latest.base_borrow_apy,
        rateChangeBps: rateChange.changeBps,
      });
    }

    // 3. Absolute threshold (warning)
    if (latest.base_borrow_apy > config.absoluteThresholdAnnualized) {
      return this.emitIfNotCooledDown(label, {
        label,
        level: 'warning',
        reason: 'absolute_threshold',
        message: `[${label}] Borrow rate elevated: ${(latest.base_borrow_apy * 100).toFixed(2)}% > ${(config.absoluteThresholdAnnualized * 100).toFixed(2)}% threshold`,
        currentRate: latest.base_borrow_apy,
      });
    }

    return null;
  }

  // ── Queries ──────────────────────────────────────────────

  /** Latest borrow APY for a label. Returns 0 if no data. */
  getLatestRate(label: string): number {
    const row = this.getLatestRow(label);
    return row?.base_borrow_apy ?? 0;
  }

  /** Average borrow APY over the last windowMinutes. Returns 0 if no data. */
  getAverageRate(label: string, windowMinutes: number): number {
    const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
    const row = this.db
      .prepare('SELECT AVG(base_borrow_apy) as avg FROM borrow_rate_history WHERE label = ? AND timestamp > ?')
      .get(label, cutoff) as { avg: number | null } | undefined;
    return row?.avg ?? 0;
  }

  /** Rate of change in bps over the last hour. Null if insufficient data. */
  getRateChangePerHour(label: string): { changeBps: number; oldRate: number; newRate: number } | null {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const oldest = this.db
      .prepare('SELECT base_borrow_apy FROM borrow_rate_history WHERE label = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 1')
      .get(label, oneHourAgo) as { base_borrow_apy: number } | undefined;

    const newest = this.db
      .prepare('SELECT base_borrow_apy FROM borrow_rate_history WHERE label = ? ORDER BY timestamp DESC LIMIT 1')
      .get(label) as { base_borrow_apy: number } | undefined;

    if (!oldest || !newest) return null;

    const changeBps = (newest.base_borrow_apy - oldest.base_borrow_apy) * 10_000;
    return {
      changeBps,
      oldRate: oldest.base_borrow_apy,
      newRate: newest.base_borrow_apy,
    };
  }

  /** Return recent borrow rate history for a label (newest first). */
  getHistory(label: string, limit: number): BorrowRateSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM borrow_rate_history WHERE label = ? ORDER BY timestamp DESC LIMIT ?')
      .all(label, limit) as BorrowRateRow[];

    return rows.map(rowToSnapshot);
  }

  // ── Cleanup ──────────────────────────────────────────────

  /** Remove records older than retentionDays. */
  prune(retentionDays: number): void {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db
      .prepare('DELETE FROM borrow_rate_history WHERE timestamp < ?')
      .run(cutoff);
    if (result.changes > 0) {
      log.info({ deleted: result.changes, retentionDays }, 'Pruned old borrow rate records');
    }
  }

  // ── Private helpers ──────────────────────────────────────

  private getLatestRow(label: string): BorrowRateRow | undefined {
    return this.db
      .prepare('SELECT * FROM borrow_rate_history WHERE label = ? ORDER BY timestamp DESC LIMIT 1')
      .get(label) as BorrowRateRow | undefined;
  }

  /** Suppress duplicate alerts within cooldown window. Critical alerts bypass cooldown from warning-level. */
  private emitIfNotCooledDown(label: string, alert: SpikeAlert): SpikeAlert | null {
    const key = `${label}:${alert.level}`;
    const now = Date.now();
    const last = this.lastAlerts.get(key);

    if (last && now - last.timestamp < BorrowRateMonitor.ALERT_COOLDOWN_MS) {
      return null;
    }

    // Critical always fires (even if warning was recently sent)
    if (alert.level === 'critical') {
      this.lastAlerts.set(key, { level: alert.level, timestamp: now });
      return alert;
    }

    this.lastAlerts.set(key, { level: alert.level, timestamp: now });
    return alert;
  }
}

function rowToSnapshot(row: BorrowRateRow): BorrowRateSnapshot {
  return {
    label: row.label,
    baseBorrowApy: row.base_borrow_apy,
    baseSupplyApy: row.base_supply_apy,
    effectiveApy: row.effective_apy,
    nativeYield: row.native_yield ?? 0,
    leverage: row.leverage ?? 1,
  };
}
