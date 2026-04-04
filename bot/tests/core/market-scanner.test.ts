import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MarketScanner } from '../../src/core/market-scanner.js';
import type { MultiplyCandidate, MultiplyRebalanceConfig, RiskAssessment } from '../../src/types.js';

// Default mock APY and capacity
function makeMockAdapter(apy = 0.15, remaining = 500_000) {
  return {
    getApy: vi.fn().mockResolvedValue(apy),
    getCapacity: vi.fn().mockResolvedValue({
      depositLimit: 1_000_000,
      totalSupply: 1_000_000 - remaining,
      remaining,
      utilizationRatio: (1_000_000 - remaining) / 1_000_000,
      dailyCapRemaining: null,
    }),
  };
}

// Use a class-based mock to satisfy Vitest 4.x new-target detection
let mockAdapterFactory: (_wallet: string, cfg: any) => any = (_w, _cfg) => makeMockAdapter();

vi.mock('../../src/connectors/defi/kamino-multiply.js', () => {
  return {
    KaminoMultiplyLending: class MockKaminoMultiplyLending {
      constructor(wallet: string, cfg: any) {
        return mockAdapterFactory(wallet, cfg);
      }
    },
  };
});

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
    // Reset to default mock
    mockAdapterFactory = (_w, _cfg) => makeMockAdapter();
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
      expect(avg).toBe(0.15);
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
      let callCount = 0;
      mockAdapterFactory = (_w, _cfg) => {
        callCount++;
        if (callCount === 1) {
          return {
            getApy: vi.fn().mockRejectedValue(new Error('RPC timeout')),
            getCapacity: vi.fn().mockRejectedValue(new Error('RPC timeout')),
          };
        }
        return makeMockAdapter(0.12, 800_000);
      };

      const scanner = createScanner([makeCandidate('Fail'), makeCandidate('OK')]);
      const results = await scanner.scanAll();

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
      const scanner = createScanner([makeCandidate('A'), makeCandidate('B')]);
      await scanner.scanAll();
      expect(scanner.getRecommendation('A', 5000)).toBeNull();
    });

    it('recommends switch when better candidate exists with sufficient diff', async () => {
      let callIdx = 0;
      mockAdapterFactory = (_w, _cfg) => {
        callIdx++;
        return makeMockAdapter(callIdx === 1 ? 0.08 : 0.20, 900_000);
      };

      const scanner = createScanner([makeCandidate('A'), makeCandidate('B')]);
      await scanner.scanAll();

      const rec = scanner.getRecommendation('A', 5000);
      expect(rec).not.toBeNull();
      expect(rec!.from).toBe('A');
      expect(rec!.to).toBe('B');
      expect(rec!.diffBps).toBe(1200);
    });

    it('respects min holding period', async () => {
      const scanner = createScanner([makeCandidate('A'), makeCandidate('B')]);
      await scanner.scanAll();
      scanner.recordSwitch();
      expect(scanner.getRecommendation('A', 5000)).toBeNull();
    });

    it('skips candidates with insufficient capacity', async () => {
      let callIdx = 0;
      mockAdapterFactory = (_w, _cfg) => {
        callIdx++;
        return makeMockAdapter(
          callIdx === 1 ? 0.05 : 0.25,
          callIdx === 1 ? 1_000_000 : 100,
        );
      };

      const scanner = createScanner([makeCandidate('A'), makeCandidate('B')]);
      await scanner.scanAll();

      const rec = scanner.getRecommendation('A', 5000);
      expect(rec).toBeNull();
    });

    it('evaluates switch economics with payback window', async () => {
      let callIdx = 0;
      mockAdapterFactory = (_w, _cfg) => {
        callIdx++;
        return makeMockAdapter(callIdx === 1 ? 0.10 : 0.12, 900_000);
      };

      const scanner = createScanner(
        [makeCandidate('A'), makeCandidate('B')],
        { estimatedSwitchCostBps: 50, estimatedSwitchCostUsd: 5 },
      );
      await scanner.scanAll();

      const rec = scanner.getRecommendation('A', 100);
      expect(rec).toBeNull();
    });
  });

  describe('getLatestScans', () => {
    it('returns all candidates with latest data', async () => {
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
    });
  });

  describe('risk assessment integration', () => {
    it('skips candidates above reject threshold', async () => {
      const mockRiskScorer = {
        assessCandidate: vi.fn().mockImplementation(async (candidate: MultiplyCandidate) => {
          const score = candidate.label === 'B' ? 80 : 20;
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

      let callIdx = 0;
      mockAdapterFactory = (_w, _cfg) => {
        callIdx++;
        return makeMockAdapter(callIdx === 1 ? 0.05 : 0.25, 900_000);
      };

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

      const rec = scanner.getRecommendation('A', 5000);
      expect(rec).toBeNull();
    });
  });
});
