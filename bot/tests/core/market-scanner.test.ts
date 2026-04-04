import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MarketScanner } from '../../src/core/market-scanner.js';
import type { MultiplyCandidate, MultiplyRebalanceConfig, RiskAssessment } from '../../src/types.js';

// Mock KaminoMultiplyLending so no RPC calls are made
vi.mock('../../src/connectors/defi/kamino-multiply.js', () => ({
  KaminoMultiplyLending: vi.fn().mockImplementation((_wallet: string, cfg: any) => ({
    getApy: vi.fn().mockResolvedValue(0.15),
    getCapacity: vi.fn().mockResolvedValue({
      depositLimit: 1_000_000,
      totalSupply: 500_000,
      remaining: 500_000,
      utilizationRatio: 0.5,
      dailyCapRemaining: null,
    }),
    name: cfg.label,
  })),
}));

vi.mock('../../src/connectors/defi/hastra-apy.js', () => ({
  getPrimeApy: vi.fn().mockResolvedValue({ apy: 0.08, source: 'mock' }),
  PRIME_MINT: 'PRIME_MOCK_MINT',
}));

const defaultRebalanceConfig: MultiplyRebalanceConfig = {
  minDiffBps: 100,
  minHoldingDays: 3,
  scanIntervalMs: 21_600_000,
  paybackWindowDays: 7,
  estimatedSwitchCostBps: 20,
  estimatedSwitchCostUsd: 1,
  minNetGainUsd: 0,
  defaultTargetHealthRate: 1.15,
  defaultAlertHealthRate: 1.10,
  defaultEmergencyHealthRate: 1.05,
};

function makeCandidate(label: string, overrides: Partial<MultiplyCandidate> = {}): MultiplyCandidate {
  return {
    market: `market-${label}`,
    collToken: `coll-${label}`,
    debtToken: `debt-${label}`,
    label,
    ...overrides,
  };
}

function createScanner(
  candidates: MultiplyCandidate[],
  configOverrides: Partial<MultiplyRebalanceConfig> = {},
) {
  const db = new Database(':memory:');
  return new MarketScanner(
    candidates,
    { ...defaultRebalanceConfig, ...configOverrides },
    'http://localhost:8899',
    'wallet123',
    new Uint8Array(64),
    db,
  );
}

describe('MarketScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getMovingAvgApy', () => {
    it('returns null when no history exists', () => {
      const scanner = createScanner([makeCandidate('A')]);
      expect(scanner.getMovingAvgApy('A')).toBeNull();
    });

    it('returns average after scan', async () => {
      const scanner = createScanner([makeCandidate('A')]);
      await scanner.scanAll();
      const avg = scanner.getMovingAvgApy('A');
      expect(avg).toBe(0.15); // single data point = itself
    });
  });

  describe('scanAll', () => {
    it('scans all candidates and returns results', async () => {
      const candidates = [makeCandidate('A'), makeCandidate('B')];
      const scanner = createScanner(candidates);

      const results = await scanner.scanAll();
      expect(results).toHaveLength(2);
      expect(results[0]!.label).toBe('A');
      expect(results[0]!.effectiveApy).toBe(0.15);
      expect(results[0]!.capacity).not.toBeNull();
      expect(results[0]!.capacity!.remaining).toBe(500_000);
    });

    it('persists APY history to SQLite', async () => {
      const db = new Database(':memory:');
      const scanner = new MarketScanner(
        [makeCandidate('A')],
        defaultRebalanceConfig,
        'http://localhost:8899',
        'wallet123',
        new Uint8Array(64),
        db,
      );

      await scanner.scanAll();

      const rows = db.prepare('SELECT * FROM multiply_apy_history').all() as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].label).toBe('A');
      expect(rows[0].effective_apy).toBe(0.15);
    });

    it('handles scan failures gracefully (Promise.allSettled)', async () => {
      const { KaminoMultiplyLending } = await import('../../src/connectors/defi/kamino-multiply.js');
      let callCount = 0;
      vi.mocked(KaminoMultiplyLending).mockImplementation((_w: string, cfg: any) => {
        callCount++;
        if (callCount === 1) {
          return {
            getApy: vi.fn().mockRejectedValue(new Error('RPC timeout')),
            getCapacity: vi.fn().mockRejectedValue(new Error('RPC timeout')),
            name: cfg.label,
          } as any;
        }
        return {
          getApy: vi.fn().mockResolvedValue(0.12),
          getCapacity: vi.fn().mockResolvedValue({
            depositLimit: 1_000_000,
            totalSupply: 200_000,
            remaining: 800_000,
            utilizationRatio: 0.2,
            dailyCapRemaining: null,
          }),
          name: cfg.label,
        } as any;
      });

      const scanner = createScanner([makeCandidate('Fail'), makeCandidate('OK')]);
      const results = await scanner.scanAll();

      // Only the successful candidate should be in results
      expect(results.length).toBe(1);
      expect(results[0]!.label).toBe('OK');
    });
  });

  describe('getRecommendation', () => {
    it('returns null when no APY data exists', () => {
      const scanner = createScanner([makeCandidate('A'), makeCandidate('B')]);
      expect(scanner.getRecommendation('A', 5000)).toBeNull();
    });

    it('returns null when current market is the best', async () => {
      // All candidates return same APY (0.15)
      const scanner = createScanner([makeCandidate('A'), makeCandidate('B')]);
      await scanner.scanAll();
      expect(scanner.getRecommendation('A', 5000)).toBeNull();
    });

    it('recommends switch when better candidate exists with sufficient diff', async () => {
      const { KaminoMultiplyLending } = await import('../../src/connectors/defi/kamino-multiply.js');
      let callIdx = 0;
      vi.mocked(KaminoMultiplyLending).mockImplementation((_w: string, cfg: any) => {
        callIdx++;
        const apy = callIdx === 1 ? 0.08 : 0.20; // A=8%, B=20%
        return {
          getApy: vi.fn().mockResolvedValue(apy),
          getCapacity: vi.fn().mockResolvedValue({
            depositLimit: 1_000_000,
            totalSupply: 100_000,
            remaining: 900_000,
            utilizationRatio: 0.1,
            dailyCapRemaining: null,
          }),
          name: cfg.label,
        } as any;
      });

      const scanner = createScanner([makeCandidate('A'), makeCandidate('B')]);
      await scanner.scanAll();

      const rec = scanner.getRecommendation('A', 5000);
      expect(rec).not.toBeNull();
      expect(rec!.from).toBe('A');
      expect(rec!.to).toBe('B');
      expect(rec!.diffBps).toBe(1200); // 12% diff
    });

    it('respects min holding period', async () => {
      const scanner = createScanner([makeCandidate('A'), makeCandidate('B')]);
      await scanner.scanAll();

      // Record a recent switch
      scanner.recordSwitch();

      // Should return null because min holding period not met
      expect(scanner.getRecommendation('A', 5000)).toBeNull();
    });

    it('skips candidates with insufficient capacity', async () => {
      const { KaminoMultiplyLending } = await import('../../src/connectors/defi/kamino-multiply.js');
      let callIdx = 0;
      vi.mocked(KaminoMultiplyLending).mockImplementation((_w: string, cfg: any) => {
        callIdx++;
        const apy = callIdx === 1 ? 0.05 : 0.25;
        const remaining = callIdx === 1 ? 1_000_000 : 100; // B has tiny capacity
        return {
          getApy: vi.fn().mockResolvedValue(apy),
          getCapacity: vi.fn().mockResolvedValue({
            depositLimit: 1_000_000,
            totalSupply: 999_900,
            remaining,
            utilizationRatio: callIdx === 1 ? 0.1 : 0.9999,
            dailyCapRemaining: null,
          }),
          name: cfg.label,
        } as any;
      });

      const scanner = createScanner([makeCandidate('A'), makeCandidate('B')]);
      await scanner.scanAll();

      // Requesting 5000 but B only has 100 capacity
      const rec = scanner.getRecommendation('A', 5000);
      expect(rec).toBeNull();
    });

    it('evaluates switch economics with payback window', async () => {
      const { KaminoMultiplyLending } = await import('../../src/connectors/defi/kamino-multiply.js');
      let callIdx = 0;
      vi.mocked(KaminoMultiplyLending).mockImplementation((_w: string, cfg: any) => {
        callIdx++;
        // A=10%, B=12% — small diff, may not clear payback window for small amounts
        const apy = callIdx === 1 ? 0.10 : 0.12;
        return {
          getApy: vi.fn().mockResolvedValue(apy),
          getCapacity: vi.fn().mockResolvedValue({
            depositLimit: 1_000_000,
            totalSupply: 100_000,
            remaining: 900_000,
            utilizationRatio: 0.1,
            dailyCapRemaining: null,
          }),
          name: cfg.label,
        } as any;
      });

      // High switch cost relative to small amount
      const scanner = createScanner(
        [makeCandidate('A'), makeCandidate('B')],
        { estimatedSwitchCostBps: 50, estimatedSwitchCostUsd: 5 },
      );
      await scanner.scanAll();

      // Small amount: economics won't justify
      const rec = scanner.getRecommendation('A', 100);
      expect(rec).toBeNull(); // switch cost exceeds expected gain
    });
  });

  describe('getLatestScans', () => {
    it('returns all candidates with latest data', async () => {
      // Reset mock to default (0.15 APY)
      const { KaminoMultiplyLending } = await import('../../src/connectors/defi/kamino-multiply.js');
      vi.mocked(KaminoMultiplyLending).mockImplementation((_w: string, cfg: any) => ({
        getApy: vi.fn().mockResolvedValue(0.15),
        getCapacity: vi.fn().mockResolvedValue({
          depositLimit: 1_000_000,
          totalSupply: 500_000,
          remaining: 500_000,
          utilizationRatio: 0.5,
          dailyCapRemaining: null,
        }),
        name: cfg.label,
      }) as any);

      const candidates = [makeCandidate('A'), makeCandidate('B')];
      const scanner = createScanner(candidates);
      await scanner.scanAll();

      const scans = scanner.getLatestScans();
      expect(scans).toHaveLength(2);
      expect(scans[0]!.label).toBe('A');
      expect(scans[0]!.effectiveApy).toBe(0.15);
      expect(scans[0]!.movingAvg).toBe(0.15);
    });

    it('returns zero APY for unscanned candidates', () => {
      const scanner = createScanner([makeCandidate('A')]);
      const scans = scanner.getLatestScans();
      expect(scans[0]!.effectiveApy).toBe(0);
      expect(scans[0]!.movingAvg).toBeNull();
    });
  });

  describe('recordSwitch', () => {
    it('resets holding period timer', () => {
      const scanner = createScanner([makeCandidate('A')]);
      scanner.recordSwitch();
      // After recording, getRecommendation should respect min holding
      // (tested indirectly via getRecommendation tests)
    });
  });

  describe('risk assessment integration', () => {
    it('skips candidates above reject threshold', async () => {
      const mockRiskScorer = {
        assessCandidate: vi.fn().mockImplementation(async (candidate: MultiplyCandidate) => {
          const score = candidate.label === 'B' ? 80 : 20; // B is risky
          return {
            label: candidate.label,
            compositeScore: score,
            dimensions: { depegRisk: 0, liquidationProximity: 0, exitLiquidity: 0, reservePressure: 0 },
            details: {} as any,
            riskPenalty: 0,
            targetHealthRate: 1.15,
            maxPositionCap: 10000,
            alertLevel: score >= 75 ? 'warning' : 'normal',
            assessedAt: Date.now(),
          } as RiskAssessment;
        }),
        getRejectThreshold: vi.fn().mockReturnValue(75),
        getEmergencyThreshold: vi.fn().mockReturnValue(90),
      } as any;

      const { KaminoMultiplyLending } = await import('../../src/connectors/defi/kamino-multiply.js');
      let callIdx = 0;
      vi.mocked(KaminoMultiplyLending).mockImplementation((_w: string, cfg: any) => {
        callIdx++;
        const apy = callIdx === 1 ? 0.05 : 0.25; // B has much higher APY but high risk
        return {
          getApy: vi.fn().mockResolvedValue(apy),
          getCapacity: vi.fn().mockResolvedValue({
            depositLimit: 1_000_000,
            totalSupply: 100_000,
            remaining: 900_000,
            utilizationRatio: 0.1,
            dailyCapRemaining: null,
          }),
          name: cfg.label,
        } as any;
      });

      const db = new Database(':memory:');
      const scanner = new MarketScanner(
        [makeCandidate('A'), makeCandidate('B')],
        defaultRebalanceConfig,
        'http://localhost:8899',
        'wallet123',
        new Uint8Array(64),
        db,
        mockRiskScorer,
      );

      await scanner.scanAll();

      // B has higher APY but risk score 80 > reject threshold 75
      const rec = scanner.getRecommendation('A', 5000);
      expect(rec).toBeNull();
    });
  });
});
