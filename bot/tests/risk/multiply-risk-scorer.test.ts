import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MultiplyRiskScorer } from '../../src/risk/multiply-risk-scorer.js';
import type { MultiplyCandidate, RiskScorerConfig } from '../../src/types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const riskConfig: RiskScorerConfig = {
  weights: {
    depegRisk: 0.3,
    liquidationProximity: 0.3,
    exitLiquidity: 0.2,
    reservePressure: 0.2,
  },
  maxDeviationBps: 200,
  maxSlippageBps: 100,
  criticalUtilization: 0.9,
  tvlSafeThreshold: 10_000_000,
  rejectThreshold: 90,
  emergencyThreshold: 85,
  emaSmoothingAlpha: 0.3,
};

const candidate: MultiplyCandidate = {
  market: '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8',
  collToken: '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5',
  debtToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  label: 'ONyc/USDC',
  collDecimals: 9,
  debtDecimals: 6,
};

function createScorer() {
  return new MultiplyRiskScorer('http://localhost:8899', riskConfig, new Database(':memory:'));
}

describe('MultiplyRiskScorer Jupiter integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.JUPITER_API_KEY;
    delete process.env.JUPITER_API_BASE_URL;
  });

  afterEach(() => {
    delete process.env.JUPITER_API_KEY;
    delete process.env.JUPITER_API_BASE_URL;
  });

  it('uses lite-api price v3 when no Jupiter API key is configured', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        [candidate.collToken]: { usdPrice: 1.0896 },
        [candidate.debtToken]: { usdPrice: 1.0001 },
      }),
    });

    const scorer = createScorer();
    const prices = await (scorer as any).fetchPrices(candidate.collToken, candidate.debtToken);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://lite-api.jup.ag/price/v3?ids='),
      expect.objectContaining({ headers: undefined }),
    );
    expect(prices).toEqual({
      collPrice: 1.0896,
      debtPrice: 1.0001,
    });
  });

  it('falls back to lite-api when the pro Jupiter endpoint rejects the request', async () => {
    process.env.JUPITER_API_KEY = 'test-api-key';

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          [candidate.collToken]: { usdPrice: 1.08 },
          [candidate.debtToken]: { usdPrice: 1.0 },
        }),
      });

    const scorer = createScorer();
    const prices = await (scorer as any).fetchPrices(candidate.collToken, candidate.debtToken);

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('https://api.jup.ag/price/v3?ids='),
      expect.objectContaining({
        headers: { 'x-api-key': 'test-api-key' },
      }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('https://lite-api.jup.ag/price/v3?ids='),
      expect.objectContaining({ headers: undefined }),
    );
    expect(prices.collPrice).toBe(1.08);
    expect(prices.debtPrice).toBe(1);
  });

  it('keeps computing dimensions with neutral prices when Jupiter price lookup fails', async () => {
    const scorer = createScorer();
    const fetchPricesSpy = vi
      .spyOn(scorer as any, 'fetchPrices')
      .mockRejectedValue(new Error('Jupiter price API 401'));
    const depegSpy = vi
      .spyOn(scorer as any, 'calcDepegRisk')
      .mockResolvedValue({ score: 12, details: { stub: true } });
    const liqSpy = vi
      .spyOn(scorer as any, 'calcLiquidationProximity')
      .mockResolvedValue({ score: 34, details: { stub: true } });
    const exitSpy = vi
      .spyOn(scorer as any, 'calcExitLiquidity')
      .mockResolvedValue({ score: 56, details: { stub: true } });
    const reserveSpy = vi
      .spyOn(scorer as any, 'calcReservePressure')
      .mockResolvedValue({ score: 78, details: { stub: true } });

    const result = await (scorer as any).computeDimensions(candidate, 10_000);

    expect(fetchPricesSpy).toHaveBeenCalledWith(candidate.collToken, candidate.debtToken);
    expect(depegSpy).toHaveBeenCalledWith(candidate, { collPrice: 0, debtPrice: 0 });
    expect(liqSpy).toHaveBeenCalledWith(candidate, { collPrice: 0, debtPrice: 0 });
    expect(exitSpy).toHaveBeenCalledWith(candidate, 10_000);
    expect(reserveSpy).toHaveBeenCalledWith(candidate);
    expect(result.dimensions).toEqual({
      depegRisk: 12,
      liquidationProximity: 34,
      exitLiquidity: 56,
      reservePressure: 78,
    });
  });

  it('uses a reference rate instead of 1.0 when computing ONyc depeg risk', async () => {
    const scorer = createScorer();
    vi.spyOn(scorer as any, 'getReferencePriceUsd')
      .mockResolvedValueOnce(1.08)
      .mockResolvedValueOnce(1.0);
    vi.spyOn(scorer as any, 'getPegVolatility24h').mockReturnValue({
      bps: 12,
      score: 24,
      sampleCount: 8,
    });
    vi.spyOn(scorer as any, 'getPegTailRisk7d').mockReturnValue({
      bps: 21,
      score: 10.5,
      sampleCount: 20,
    });
    vi.spyOn(scorer as any, 'storePegDeviation').mockImplementation(() => {});

    const result = await (scorer as any).calcDepegRisk(candidate, {
      collPrice: 1.0896,
      debtPrice: 1.0001,
    });

    expect(result.details.expectedRate).toBe(1.08);
    expect(result.details.deviationBps).toBeLessThan(100);
    expect(result.details.deviationBps).toBeGreaterThan(80);
    expect(result.score).toBeGreaterThan(0);
  });
});
