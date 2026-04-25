import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BorrowRateMonitor } from '../../src/core/borrow-rate-monitor.js';
import type { BorrowRateSpikeConfig } from '../../src/types.js';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS borrow_rate_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    label TEXT NOT NULL,
    base_borrow_apy REAL NOT NULL,
    base_supply_apy REAL NOT NULL,
    effective_apy REAL NOT NULL,
    native_yield REAL,
    leverage REAL
  );
  CREATE INDEX IF NOT EXISTS idx_borrow_rate_label_ts
    ON borrow_rate_history(label, timestamp);
`;

const DEFAULT_CONFIG: BorrowRateSpikeConfig = {
  absoluteThresholdAnnualized: 0.20,
  rateChangeThresholdBps: 500,
  negativeSpreadThreshold: 0,
  sampleRetentionDays: 7,
};

let db: Database.Database;
let monitor: BorrowRateMonitor;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  monitor = new BorrowRateMonitor(db);
});

afterEach(() => {
  db.close();
});

/** Insert a borrow rate record at a specific timestamp */
function insertRate(label: string, baseBorrowApy: number, effectiveApy: number, timestamp: string) {
  db.prepare(`
    INSERT INTO borrow_rate_history (timestamp, label, base_borrow_apy, base_supply_apy, effective_apy, native_yield, leverage)
    VALUES (?, ?, ?, 0.05, ?, 0.10, 2.5)
  `).run(timestamp, label, baseBorrowApy, effectiveApy);
}

describe('BorrowRateMonitor', () => {
  describe('recordRate', () => {
    it('records a borrow rate snapshot', () => {
      monitor.recordRate({
        label: 'ONyc/USDC',
        baseBorrowApy: 0.05,
        baseSupplyApy: 0.03,
        effectiveApy: 0.16,
        nativeYield: 0.10,
        leverage: 2.5,
      });

      const rows = db.prepare('SELECT COUNT(*) as count FROM borrow_rate_history').get() as { count: number };
      expect(rows.count).toBe(1);
    });

    it('deduplicates within the same 5-minute window', () => {
      monitor.recordRate({
        label: 'ONyc/USDC',
        baseBorrowApy: 0.05,
        baseSupplyApy: 0.03,
        effectiveApy: 0.16,
        nativeYield: 0.10,
        leverage: 2.5,
      });

      // Second call in same window should be deduped
      monitor.recordRate({
        label: 'ONyc/USDC',
        baseBorrowApy: 0.06,
        baseSupplyApy: 0.03,
        effectiveApy: 0.15,
        nativeYield: 0.10,
        leverage: 2.5,
      });

      const rows = db.prepare('SELECT COUNT(*) as count FROM borrow_rate_history').get() as { count: number };
      expect(rows.count).toBe(1);
    });
  });

  describe('getLatestRate', () => {
    it('returns 0 when no data', () => {
      expect(monitor.getLatestRate('ONyc/USDC')).toBe(0);
    });

    it('returns the latest borrow APY', () => {
      insertRate('ONyc/USDC', 0.05, 0.16, '2026-04-25T00:00:00Z');
      insertRate('ONyc/USDC', 0.08, 0.12, '2026-04-25T00:05:00Z');

      expect(monitor.getLatestRate('ONyc/USDC')).toBe(0.08);
    });
  });

  describe('getAverageRate', () => {
    it('returns 0 when no data', () => {
      expect(monitor.getAverageRate('ONyc/USDC', 60)).toBe(0);
    });

    it('computes average over window', () => {
      const now = new Date();
      const t1 = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
      const t2 = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
      insertRate('ONyc/USDC', 0.04, 0.16, t1);
      insertRate('ONyc/USDC', 0.06, 0.14, t2);

      const avg = monitor.getAverageRate('ONyc/USDC', 60);
      expect(avg).toBeCloseTo(0.05, 4);
    });
  });

  describe('getRateChangePerHour', () => {
    it('returns null when insufficient data', () => {
      expect(monitor.getRateChangePerHour('ONyc/USDC')).toBeNull();
    });

    it('calculates rate change in bps', () => {
      const now = new Date();
      const t1 = new Date(now.getTime() - 50 * 60 * 1000).toISOString();
      const t2 = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
      insertRate('ONyc/USDC', 0.05, 0.16, t1);
      insertRate('ONyc/USDC', 0.10, 0.11, t2);

      const change = monitor.getRateChangePerHour('ONyc/USDC');
      expect(change).not.toBeNull();
      expect(change!.changeBps).toBeCloseTo(500, 0); // (0.10 - 0.05) * 10000 = 500
      expect(change!.oldRate).toBe(0.05);
      expect(change!.newRate).toBe(0.10);
    });
  });

  describe('detectSpike', () => {
    it('returns null when no data', () => {
      expect(monitor.detectSpike('ONyc/USDC', DEFAULT_CONFIG)).toBeNull();
    });

    it('detects negative spread (critical)', () => {
      const now = new Date();
      insertRate('ONyc/USDC', 0.25, -0.05, new Date(now.getTime() - 5 * 60 * 1000).toISOString());

      const spike = monitor.detectSpike('ONyc/USDC', DEFAULT_CONFIG);
      expect(spike).not.toBeNull();
      expect(spike!.level).toBe('critical');
      expect(spike!.reason).toBe('negative_spread');
    });

    it('detects rate change spike (warning)', () => {
      const now = new Date();
      insertRate('ONyc/USDC', 0.05, 0.16, new Date(now.getTime() - 50 * 60 * 1000).toISOString());
      insertRate('ONyc/USDC', 0.15, 0.06, new Date(now.getTime() - 5 * 60 * 1000).toISOString());

      const spike = monitor.detectSpike('ONyc/USDC', DEFAULT_CONFIG);
      expect(spike).not.toBeNull();
      expect(spike!.level).toBe('warning');
      expect(spike!.reason).toBe('rate_change');
    });

    it('detects absolute threshold breach (warning)', () => {
      const now = new Date();
      insertRate('ONyc/USDC', 0.25, 0.05, new Date(now.getTime() - 5 * 60 * 1000).toISOString());

      const spike = monitor.detectSpike('ONyc/USDC', DEFAULT_CONFIG);
      expect(spike).not.toBeNull();
      expect(spike!.level).toBe('warning');
      expect(spike!.reason).toBe('absolute_threshold');
    });

    it('returns null when rates are normal', () => {
      const now = new Date();
      insertRate('ONyc/USDC', 0.05, 0.16, new Date(now.getTime() - 50 * 60 * 1000).toISOString());
      insertRate('ONyc/USDC', 0.06, 0.15, new Date(now.getTime() - 5 * 60 * 1000).toISOString());

      const spike = monitor.detectSpike('ONyc/USDC', DEFAULT_CONFIG);
      expect(spike).toBeNull();
    });

    it('suppresses duplicate alerts within cooldown', () => {
      const now = new Date();
      insertRate('ONyc/USDC', 0.25, 0.05, new Date(now.getTime() - 5 * 60 * 1000).toISOString());

      const spike1 = monitor.detectSpike('ONyc/USDC', DEFAULT_CONFIG);
      expect(spike1).not.toBeNull();

      // Second call should be suppressed
      const spike2 = monitor.detectSpike('ONyc/USDC', DEFAULT_CONFIG);
      expect(spike2).toBeNull();
    });
  });

  describe('getHistory', () => {
    it('returns empty array when no data', () => {
      expect(monitor.getHistory('ONyc/USDC', 10)).toHaveLength(0);
    });

    it('returns history in newest-first order', () => {
      insertRate('ONyc/USDC', 0.05, 0.16, '2026-04-25T00:00:00Z');
      insertRate('ONyc/USDC', 0.06, 0.15, '2026-04-25T00:05:00Z');
      insertRate('ONyc/USDC', 0.07, 0.14, '2026-04-25T00:10:00Z');

      const history = monitor.getHistory('ONyc/USDC', 2);
      expect(history).toHaveLength(2);
      expect(history[0]!.baseBorrowApy).toBe(0.07);
      expect(history[1]!.baseBorrowApy).toBe(0.06);
    });
  });

  describe('prune', () => {
    it('removes records older than retention period', () => {
      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      insertRate('ONyc/USDC', 0.05, 0.16, old);
      insertRate('ONyc/USDC', 0.06, 0.15, recent);

      monitor.prune(7);

      const rows = db.prepare('SELECT COUNT(*) as count FROM borrow_rate_history').get() as { count: number };
      expect(rows.count).toBe(1);
    });
  });
});
