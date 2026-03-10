import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { FrMonitor } from '../../src/core/fr-monitor.js';
import { frToAnnualized } from '../../src/utils/math.js';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS fr_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    symbol TEXT NOT NULL,
    funding_rate REAL NOT NULL,
    annualized_rate REAL NOT NULL,
    mark_price REAL
  );
`;

let db: Database.Database;
let monitor: FrMonitor;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  monitor = new FrMonitor(db);
});

afterEach(() => {
  db.close();
});

/** Helper: insert FR data for a given UTC date with 3 entries (every 8h) */
function insertDayFr(date: string, rates: [number, number, number]) {
  for (let i = 0; i < 3; i++) {
    const hour = String(i * 8).padStart(2, '0');
    monitor.recordFundingRate({
      symbol: 'SOLUSDT',
      fundingRate: rates[i]!,
      fundingTime: new Date(`${date}T${hour}:00:00Z`).getTime(),
      markPrice: 150,
    });
  }
}

// ── recordFundingRate ────────────────────────────────────

describe('recordFundingRate', () => {
  it('inserts a record into the database', () => {
    monitor.recordFundingRate({
      symbol: 'SOLUSDT',
      fundingRate: 0.0001,
      fundingTime: Date.now(),
      markPrice: 150,
    });

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM fr_history').get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('stores correct annualized rate', () => {
    const fr = 0.0001;
    monitor.recordFundingRate({
      symbol: 'SOLUSDT',
      fundingRate: fr,
      fundingTime: Date.now(),
    });

    const row = db.prepare('SELECT annualized_rate FROM fr_history LIMIT 1').get() as { annualized_rate: number };
    expect(row.annualized_rate).toBeCloseTo(frToAnnualized(fr), 4);
  });
});

// ── getLatestRate / getLatestAnnualized ───────────────────

describe('getLatestRate', () => {
  it('returns null when no data', () => {
    expect(monitor.getLatestRate()).toBeNull();
  });

  it('returns the most recent record', () => {
    monitor.recordFundingRate({
      symbol: 'SOLUSDT',
      fundingRate: 0.0001,
      fundingTime: new Date('2026-01-01T00:00:00Z').getTime(),
    });
    monitor.recordFundingRate({
      symbol: 'SOLUSDT',
      fundingRate: 0.0005,
      fundingTime: new Date('2026-01-01T08:00:00Z').getTime(),
    });

    const latest = monitor.getLatestRate();
    expect(latest).not.toBeNull();
    expect(latest!.fundingRate).toBe(0.0005);
  });
});

describe('getLatestAnnualized', () => {
  it('returns 0 when no data', () => {
    expect(monitor.getLatestAnnualized()).toBe(0);
  });

  it('returns the latest annualized rate', () => {
    const fr = 0.0002;
    monitor.recordFundingRate({
      symbol: 'SOLUSDT',
      fundingRate: fr,
      fundingTime: Date.now(),
    });
    expect(monitor.getLatestAnnualized()).toBeCloseTo(frToAnnualized(fr), 4);
  });
});

// ── getAverageAnnualized ─────────────────────────────────

describe('getAverageAnnualized', () => {
  it('returns 0 when no data', () => {
    expect(monitor.getAverageAnnualized(3)).toBe(0);
  });

  it('averages the last N*3 records', () => {
    // 3 days * 3 = 9 records
    insertDayFr('2026-01-01', [0.0001, 0.0002, 0.0003]);
    insertDayFr('2026-01-02', [0.0004, 0.0005, 0.0006]);
    insertDayFr('2026-01-03', [0.0007, 0.0008, 0.0009]);

    const avg = monitor.getAverageAnnualized(3);
    const expectedAvgFr = (0.0001 + 0.0002 + 0.0003 + 0.0004 + 0.0005 + 0.0006 + 0.0007 + 0.0008 + 0.0009) / 9;
    expect(avg).toBeCloseTo(frToAnnualized(expectedAvgFr), 2);
  });

  it('only uses last N days of data even if more exists', () => {
    insertDayFr('2026-01-01', [0.0001, 0.0001, 0.0001]); // old, should be excluded
    insertDayFr('2026-01-02', [0.0010, 0.0010, 0.0010]);
    insertDayFr('2026-01-03', [0.0010, 0.0010, 0.0010]);

    // Average of last 2 days (6 records)
    const avg = monitor.getAverageAnnualized(2);
    expect(avg).toBeCloseTo(frToAnnualized(0.001), 2);
  });
});

// ── getDaysAboveThreshold ────────────────────────────────

describe('getDaysAboveThreshold', () => {
  it('returns 0 when no data', () => {
    expect(monitor.getDaysAboveThreshold(10)).toBe(0);
  });

  it('counts consecutive days where ALL FRs are above threshold', () => {
    // FR 0.0001 → annualized 10.95%
    // threshold 10% → all above
    insertDayFr('2026-01-01', [0.0001, 0.0001, 0.0001]);
    insertDayFr('2026-01-02', [0.0001, 0.0001, 0.0001]);
    insertDayFr('2026-01-03', [0.0001, 0.0001, 0.0001]);

    expect(monitor.getDaysAboveThreshold(10)).toBe(3);
  });

  it('breaks streak when one FR in a day is below threshold', () => {
    // Day 1 and 2: all above. Day 3: one below → streak breaks at day 3
    insertDayFr('2026-01-01', [0.0001, 0.0001, 0.0001]); // all above 10%
    insertDayFr('2026-01-02', [0.0001, 0.00005, 0.0001]); // one below (~5.475%) → breaks
    insertDayFr('2026-01-03', [0.0001, 0.0001, 0.0001]); // all above

    // Most recent day (Jan 3) is above, but Jan 2 breaks → count = 1
    expect(monitor.getDaysAboveThreshold(10)).toBe(1);
  });

  it('returns 0 when most recent day is below threshold', () => {
    insertDayFr('2026-01-01', [0.0001, 0.0001, 0.0001]);
    insertDayFr('2026-01-02', [0.00001, 0.00001, 0.00001]); // ~1.095%

    expect(monitor.getDaysAboveThreshold(10)).toBe(0);
  });
});

// ── getDaysBelowThreshold ────────────────────────────────

describe('getDaysBelowThreshold', () => {
  it('returns 0 when no data', () => {
    expect(monitor.getDaysBelowThreshold(0)).toBe(0);
  });

  it('counts consecutive days where ALL FRs are below threshold', () => {
    // FR -0.0001 → annualized -10.95%, threshold 0%
    insertDayFr('2026-01-01', [-0.0001, -0.0001, -0.0001]);
    insertDayFr('2026-01-02', [-0.0001, -0.0001, -0.0001]);

    expect(monitor.getDaysBelowThreshold(0)).toBe(2);
  });

  it('breaks streak when one FR in a day is above threshold', () => {
    insertDayFr('2026-01-01', [-0.0001, -0.0001, -0.0001]);
    insertDayFr('2026-01-02', [-0.0001, 0.0001, -0.0001]); // one positive
    insertDayFr('2026-01-03', [-0.0001, -0.0001, -0.0001]);

    // Most recent (Jan 3) below, Jan 2 breaks → count = 1
    expect(monitor.getDaysBelowThreshold(0)).toBe(1);
  });
});

// ── getFrHistory ─────────────────────────────────────────

describe('getFrHistory', () => {
  it('returns empty array when no data', () => {
    expect(monitor.getFrHistory(10)).toEqual([]);
  });

  it('returns records in newest-first order', () => {
    insertDayFr('2026-01-01', [0.0001, 0.0002, 0.0003]);

    const history = monitor.getFrHistory(10);
    expect(history).toHaveLength(3);
    expect(history[0]!.fundingRate).toBe(0.0003); // newest
    expect(history[2]!.fundingRate).toBe(0.0001); // oldest
  });

  it('respects limit parameter', () => {
    insertDayFr('2026-01-01', [0.0001, 0.0002, 0.0003]);
    insertDayFr('2026-01-02', [0.0004, 0.0005, 0.0006]);

    const history = monitor.getFrHistory(3);
    expect(history).toHaveLength(3);
  });
});
