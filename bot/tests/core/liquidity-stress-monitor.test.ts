import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { LiquidityStressMonitor } from '../../src/core/liquidity-stress-monitor.js';

// Mock sendAlert to prevent actual Telegram calls
vi.mock('../../src/utils/notify.js', () => ({
  sendAlert: vi.fn(),
}));

import { sendAlert } from '../../src/utils/notify.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

/** Insert a stress test record directly for query testing */
function insertRecord(
  label: string,
  positionUsd: number,
  tier: number,
  exitUsd: number,
  priceImpactPct: number,
  slippageBps: number,
  timestamp: string,
) {
  db.prepare(`
    INSERT INTO liquidity_stress_history
      (timestamp, label, position_usd, tier, exit_usd, price_impact_pct, slippage_bps)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(timestamp, label, positionUsd, tier, exitUsd, priceImpactPct, slippageBps);
}

describe('LiquidityStressMonitor', () => {
  describe('constructor', () => {
    it('creates the liquidity_stress_history table', () => {
      const monitor = new LiquidityStressMonitor(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='liquidity_stress_history'")
        .all() as { name: string }[];
      expect(tables).toHaveLength(1);
    });

    it('accepts custom config', () => {
      const monitor = new LiquidityStressMonitor(db, {
        warningSlippageBps: 50,
        criticalSlippageBps: 200,
      });

      // Should not throw
      expect(monitor).toBeDefined();
    });
  });

  describe('runStressTest', () => {
    it('returns empty result for zero-balance positions', async () => {
      const monitor = new LiquidityStressMonitor(db);

      const result = await monitor.runStressTest({
        label: 'ONyc/USDC',
        collToken: 'COLL_MINT',
        debtToken: 'DEBT_MINT',
        collDecimals: 6,
        positionUsd: 0,
      });

      expect(result.tiers).toHaveLength(0);
      expect(result.maxSlippageBps).toBe(0);
      expect(result.alertLevel).toBeNull();
    });

    it('fetches quotes for 3 tiers and persists results', async () => {
      const monitor = new LiquidityStressMonitor(db);

      // Mock the private fetchJupiterQuote via globalThis.fetch
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ priceImpactPct: '0.5' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await monitor.runStressTest({
        label: 'ONyc/USDC',
        collToken: 'COLL_MINT',
        debtToken: 'DEBT_MINT',
        collDecimals: 6,
        positionUsd: 1000,
      });

      expect(result.tiers).toHaveLength(3);
      expect(result.tiers[0]!.tier).toBe(0.25);
      expect(result.tiers[0]!.exitUsd).toBe(250);
      expect(result.tiers[1]!.tier).toBe(0.50);
      expect(result.tiers[1]!.exitUsd).toBe(500);
      expect(result.tiers[2]!.tier).toBe(1.0);
      expect(result.tiers[2]!.exitUsd).toBe(1000);

      // All tiers should have 50 bps (0.5% * 100)
      for (const tier of result.tiers) {
        expect(tier.slippageBps).toBe(50);
      }

      // Check DB persistence
      const rows = db.prepare('SELECT COUNT(*) as count FROM liquidity_stress_history').get() as { count: number };
      expect(rows.count).toBe(3);

      vi.unstubAllGlobals();
    });

    it('triggers warning alert when slippage exceeds threshold', async () => {
      const monitor = new LiquidityStressMonitor(db, {
        warningSlippageBps: 80,
        criticalSlippageBps: 300,
        alertCooldownMs: 1_800_000,
        retentionDays: 7,
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ priceImpactPct: '1.5' }), // 150 bps
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await monitor.runStressTest({
        label: 'ONyc/USDC',
        collToken: 'COLL_MINT',
        debtToken: 'DEBT_MINT',
        collDecimals: 6,
        positionUsd: 5000,
      });

      expect(result.alertLevel).toBe('warning');
      expect(result.maxSlippageBps).toBe(150);
      expect(sendAlert).toHaveBeenCalledWith(
        expect.stringContaining('Liquidity Stress [ONyc/USDC]'),
        'warning',
      );

      vi.unstubAllGlobals();
    });

    it('triggers critical alert when slippage exceeds critical threshold', async () => {
      const monitor = new LiquidityStressMonitor(db, {
        warningSlippageBps: 100,
        criticalSlippageBps: 300,
        alertCooldownMs: 1_800_000,
        retentionDays: 7,
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ priceImpactPct: '4.0' }), // 400 bps
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await monitor.runStressTest({
        label: 'ONyc/USDC',
        collToken: 'COLL_MINT',
        debtToken: 'DEBT_MINT',
        collDecimals: 6,
        positionUsd: 10000,
      });

      expect(result.alertLevel).toBe('critical');
      expect(sendAlert).toHaveBeenCalledWith(
        expect.stringContaining('Max slippage: 400.0 bps'),
        'critical',
      );

      vi.unstubAllGlobals();
    });

    it('suppresses alerts within cooldown window', async () => {
      const monitor = new LiquidityStressMonitor(db, {
        warningSlippageBps: 50,
        criticalSlippageBps: 300,
        alertCooldownMs: 1_800_000,
        retentionDays: 7,
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ priceImpactPct: '1.0' }), // 100 bps > 50 warning
      });
      vi.stubGlobal('fetch', fetchMock);

      const params = {
        label: 'ONyc/USDC',
        collToken: 'COLL_MINT',
        debtToken: 'DEBT_MINT',
        collDecimals: 6,
        positionUsd: 1000,
      };

      await monitor.runStressTest(params);
      expect(sendAlert).toHaveBeenCalledTimes(1);

      // Second call should be suppressed
      await monitor.runStressTest(params);
      expect(sendAlert).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });

    it('handles Jupiter API failure gracefully', async () => {
      const monitor = new LiquidityStressMonitor(db);

      const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', fetchMock);

      const result = await monitor.runStressTest({
        label: 'ONyc/USDC',
        collToken: 'COLL_MINT',
        debtToken: 'DEBT_MINT',
        collDecimals: 6,
        positionUsd: 1000,
      });

      // Should record -1 slippageBps for failed tiers
      expect(result.tiers).toHaveLength(3);
      for (const tier of result.tiers) {
        expect(tier.slippageBps).toBe(-1);
      }
      expect(result.maxSlippageBps).toBe(0);

      vi.unstubAllGlobals();
    });
  });

  describe('getLatest', () => {
    it('returns null when no data', () => {
      const monitor = new LiquidityStressMonitor(db);
      expect(monitor.getLatest('ONyc/USDC')).toBeNull();
    });

    it('returns latest stress test result', () => {
      const monitor = new LiquidityStressMonitor(db);
      const ts = '2026-04-25T12:00:00Z';

      insertRecord('ONyc/USDC', 5000, 0.25, 1250, 0.3, 30, ts);
      insertRecord('ONyc/USDC', 5000, 0.50, 2500, 0.5, 50, ts);
      insertRecord('ONyc/USDC', 5000, 1.00, 5000, 1.2, 120, ts);

      const result = monitor.getLatest('ONyc/USDC');
      expect(result).not.toBeNull();
      expect(result!.tiers).toHaveLength(3);
      expect(result!.maxSlippageBps).toBe(120);
      expect(result!.positionUsd).toBe(5000);
    });
  });

  describe('getFullExitTrend', () => {
    it('returns empty array when no data', () => {
      const monitor = new LiquidityStressMonitor(db);
      expect(monitor.getFullExitTrend('ONyc/USDC')).toHaveLength(0);
    });

    it('returns 100% exit tier trend', () => {
      const monitor = new LiquidityStressMonitor(db);
      const now = Date.now();
      const t1 = new Date(now - 2 * 3_600_000).toISOString();
      const t2 = new Date(now - 1 * 3_600_000).toISOString();

      // 25% tier — should NOT appear in full exit trend
      insertRecord('ONyc/USDC', 5000, 0.25, 1250, 0.2, 20, t1);
      // 100% tiers — should appear
      insertRecord('ONyc/USDC', 5000, 1.0, 5000, 0.8, 80, t1);
      insertRecord('ONyc/USDC', 5000, 1.0, 5000, 1.5, 150, t2);

      const trend = monitor.getFullExitTrend('ONyc/USDC', 24);
      expect(trend).toHaveLength(2);
      expect(trend[0]!.slippageBps).toBe(80);
      expect(trend[1]!.slippageBps).toBe(150);
    });
  });

  describe('prune', () => {
    it('removes records older than retention period', () => {
      const monitor = new LiquidityStressMonitor(db);
      const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
      const recent = new Date(Date.now() - 1 * 3_600_000).toISOString();

      insertRecord('ONyc/USDC', 5000, 1.0, 5000, 0.5, 50, old);
      insertRecord('ONyc/USDC', 5000, 1.0, 5000, 0.8, 80, recent);

      monitor.prune(7);

      const rows = db.prepare('SELECT COUNT(*) as count FROM liquidity_stress_history').get() as { count: number };
      expect(rows.count).toBe(1);
    });
  });
});
