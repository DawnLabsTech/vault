/**
 * Quantitative risk scorer for Kamino Multiply pairs.
 *
 * Computes a composite risk score (0-100) from 4 independently measurable dimensions:
 *   D1: Depeg Risk (30%) — collateral/debt peg deviation + volatility + tail risk
 *   D2: Liquidation Proximity (30%) — distance to liquidation at target leverage
 *   D3: Exit Liquidity (20%) — swap slippage on emergency exit
 *   D4: Reserve Pressure (20%) — reserve utilization + capacity + TVL floor
 *
 * The composite score maps to operational parameters:
 *   - Risk penalty (APY deduction)
 *   - Target health rate
 *   - Max position cap
 *   - Alert level
 */
import { createChildLogger } from '../utils/logger.js';
import { KaminoMarket, DEFAULT_RECENT_SLOT_DURATION_MS } from '@kamino-finance/klend-sdk';
import { createSolanaRpc, address } from '@solana/kit';
import Decimal from 'decimal.js';
import type Database from 'better-sqlite3';
import { getOnycApy, isOnycToken } from '../connectors/defi/onre-apy.js';
import type {
  MultiplyCandidate,
  RiskDimensionDetails,
  RiskDimensionScores,
  RiskAssessment,
  RiskAlertLevel,
  RiskScorerConfig,
} from '../types.js';

const log = createChildLogger('multiply-risk-scorer');

const JUPITER_PRO_API_BASE = 'https://api.jup.ag';
const JUPITER_LITE_API_BASE = 'https://lite-api.jup.ag';
const JUPITER_PRICE_API_PATH = '/price/v3';
const JUPITER_QUOTE_API_PATH = '/swap/v1/quote';

// Well-known stablecoin mints
const STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',  // USDS
  'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH', // CASH
]);

/** Clamp value to [0, 100] */
function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function getJupiterApiBaseCandidates(): string[] {
  const configuredBaseUrl = process.env.JUPITER_API_BASE_URL?.trim();
  if (configuredBaseUrl) {
    return [trimTrailingSlash(configuredBaseUrl)];
  }

  return process.env.JUPITER_API_KEY
    ? [JUPITER_PRO_API_BASE, JUPITER_LITE_API_BASE]
    : [JUPITER_LITE_API_BASE, JUPITER_PRO_API_BASE];
}

function getJupiterHeaders(baseUrl: string): HeadersInit | undefined {
  const apiKey = process.env.JUPITER_API_KEY?.trim();
  if (!apiKey) return undefined;
  if (trimTrailingSlash(baseUrl) !== JUPITER_PRO_API_BASE) return undefined;
  return { 'x-api-key': apiKey };
}

function parseJupiterUsdPrice(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const entry = value as { usdPrice?: number | string; price?: number | string };
  return parseFloat(String(entry.usdPrice ?? entry.price ?? '0'));
}

interface DimensionResult<TDetails> {
  score: number;
  details: TDetails;
}

/** Standard deviation of an array of numbers */
function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Default target health rate when candidate doesn't specify one */
const DEFAULT_TARGET_HEALTH_RATE = 1.15;

export class MultiplyRiskScorer {
  private rpcUrl: string;
  private config: RiskScorerConfig;
  private db: Database.Database;

  // Cached Kamino markets (keyed by market address)
  private marketCache: Map<string, { market: KaminoMarket; loadedAt: number }> = new Map();
  private readonly MARKET_CACHE_TTL = 5 * 60 * 1000; // 5 min

  // EMA smoothed composite scores
  private emaScores: Map<string, number> = new Map();

  private insertRiskStmt: Database.Statement | null = null;

  constructor(rpcUrl: string, config: RiskScorerConfig, db: Database.Database) {
    this.rpcUrl = rpcUrl;
    this.config = config;
    this.db = db;
    this.initDb();
    this.loadEmaScores();
  }

  // ── DB Setup ──────────────────────────────────────────────

  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS multiply_risk_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        composite_score REAL NOT NULL,
        peg_stability REAL,
        liquidity_depth REAL,
        reserve_utilization REAL,
        tvl_protocol REAL,
        borrow_rate_vol REAL,
        collateral_type REAL,
        risk_penalty REAL,
        target_health_rate REAL,
        max_position_cap REAL,
        alert_level TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_risk_scores_label_ts
        ON multiply_risk_scores(label, timestamp);
    `);

    // Add new dimension columns (safe if already exist)
    try {
      this.db.exec('ALTER TABLE multiply_risk_scores ADD COLUMN depeg_risk REAL');
    } catch { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE multiply_risk_scores ADD COLUMN liquidation_proximity REAL');
    } catch { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE multiply_risk_scores ADD COLUMN exit_liquidity REAL');
    } catch { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE multiply_risk_scores ADD COLUMN reserve_pressure REAL');
    } catch { /* column already exists */ }

    this.insertRiskStmt = this.db.prepare(`
      INSERT INTO multiply_risk_scores
        (label, composite_score, depeg_risk, liquidation_proximity, exit_liquidity,
         reserve_pressure, risk_penalty, target_health_rate, max_position_cap,
         alert_level, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Extend multiply_apy_history with extra columns (safe if already exist)
    try {
      this.db.exec('ALTER TABLE multiply_apy_history ADD COLUMN supply_apy REAL');
    } catch { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE multiply_apy_history ADD COLUMN borrow_apy REAL');
    } catch { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE multiply_apy_history ADD COLUMN peg_deviation_bps REAL');
    } catch { /* column already exists */ }

    // DB cleanup: keep 7 days
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    this.db.prepare('DELETE FROM multiply_risk_scores WHERE timestamp < ?').run(cutoff);
  }

  /** Load last EMA scores from DB to resume smoothing across restarts */
  private loadEmaScores(): void {
    try {
      const rows = this.db
        .prepare(`
          SELECT label, composite_score
          FROM multiply_risk_scores
          WHERE id IN (SELECT MAX(id) FROM multiply_risk_scores GROUP BY label)
        `)
        .all() as { label: string; composite_score: number }[];
      for (const row of rows) {
        this.emaScores.set(row.label, row.composite_score);
      }
      log.info({ labels: [...this.emaScores.keys()] }, 'Loaded EMA risk scores from DB');
    } catch {
      log.debug('No prior risk scores found');
    }
  }

  // ── Core API ──────────────────────────────────────────────

  async assessCandidate(
    candidate: MultiplyCandidate,
    maxPositionCapUsd: number = 10_000,
  ): Promise<RiskAssessment> {
    const now = Date.now();
    const { dimensions, details } = await this.computeDimensions(candidate, maxPositionCapUsd);
    const w = this.config.weights;

    const rawScore =
      w.depegRisk * dimensions.depegRisk +
      w.liquidationProximity * dimensions.liquidationProximity +
      w.exitLiquidity * dimensions.exitLiquidity +
      w.reservePressure * dimensions.reservePressure;

    // EMA smoothing
    const prevEma = this.emaScores.get(candidate.label);
    const alpha = this.config.emaSmoothingAlpha;
    const compositeScore = prevEma !== undefined
      ? clamp(alpha * rawScore + (1 - alpha) * prevEma)
      : clamp(rawScore);
    this.emaScores.set(candidate.label, compositeScore);

    const assessment: RiskAssessment = {
      label: candidate.label,
      compositeScore,
      dimensions,
      details,
      riskPenalty: 0,
      targetHealthRate: MultiplyRiskScorer.scoreToHealthRate(compositeScore),
      maxPositionCap: MultiplyRiskScorer.scoreToPositionCap(compositeScore, maxPositionCapUsd),
      alertLevel: MultiplyRiskScorer.scoreToAlertLevel(compositeScore),
      assessedAt: now,
    };

    this.persistAssessment(assessment);

    log.info(
      {
        label: candidate.label,
        composite: compositeScore.toFixed(1),
        raw: rawScore.toFixed(1),
        d1: dimensions.depegRisk.toFixed(1),
        d2: dimensions.liquidationProximity.toFixed(1),
        d3: dimensions.exitLiquidity.toFixed(1),
        d4: dimensions.reservePressure.toFixed(1),
        healthTarget: assessment.targetHealthRate.toFixed(2),
        alert: assessment.alertLevel,
      },
      'Risk assessment complete',
    );

    return assessment;
  }

  async assessAll(
    candidates: MultiplyCandidate[],
    maxPositionCapUsd: number = 10_000,
  ): Promise<RiskAssessment[]> {
    const results = await Promise.allSettled(
      candidates.map((c) => this.assessCandidate(c, maxPositionCapUsd)),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<RiskAssessment> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  // ── Dimension Calculators ─────────────────────────────────

  private async computeDimensions(
    candidate: MultiplyCandidate,
    maxPositionCapUsd: number,
  ): Promise<{ dimensions: RiskDimensionScores; details: RiskDimensionDetails }> {
    // Fetch prices once, shared by D1 (depegRisk) and D2 (liquidationProximity)
    const prices = await this.fetchPrices(candidate.collToken, candidate.debtToken).catch((err) => {
      log.warn({ label: candidate.label, error: (err as Error).message }, 'Shared Jupiter price fetch failed');
      return { collPrice: 0, debtPrice: 0 };
    });

    const [depegRisk, liquidationProximity, exitLiquidity, reservePressure] =
      await Promise.all([
        this.calcDepegRisk(candidate, prices).catch((err) => {
          log.warn({ label: candidate.label, error: (err as Error).message }, 'D1 depeg risk failed');
          return {
            score: 50,
            details: {
              collPriceUsd: prices.collPrice,
              debtPriceUsd: prices.debtPrice,
              marketRate: prices.debtPrice > 0 ? prices.collPrice / prices.debtPrice : 0,
              expectedRate: 0,
              deviationBps: 0,
              spotScore: 50,
              volatility24hBps: 0,
              volatility24hScore: 50,
              volatilitySampleCount: 0,
              tailRisk7dBps: 0,
              tailRisk7dScore: 50,
              tailRiskSampleCount: 0,
            },
          };
        }),
        this.calcLiquidationProximity(candidate, prices).catch((err) => {
          log.warn({ label: candidate.label, error: (err as Error).message }, 'D2 liquidation proximity failed');
          return {
            score: 50,
            details: {
              liquidationLtv: 0,
              targetHealthRate: candidate.targetHealthRate ?? DEFAULT_TARGET_HEALTH_RATE,
              targetLeverage: 0,
              marketRate: prices.debtPrice > 0 ? prices.collPrice / prices.debtPrice : 0,
              simulatedHealthRate: 0,
              stressedMarketRate: 0,
              stressedHealthRate: 0,
              baseScore: 50,
              stressScore: 50,
            },
          };
        }),
        this.calcExitLiquidity(candidate, maxPositionCapUsd).catch((err) => {
          log.warn({ label: candidate.label, error: (err as Error).message }, 'D3 exit liquidity failed');
          return {
            score: 50,
            details: {
              assumedExitUsd: maxPositionCapUsd,
              quoteInputAmount: 0,
              priceImpactPct: 0,
              slippageBps: 0,
            },
          };
        }),
        this.calcReservePressure(candidate).catch((err) => {
          log.warn({ label: candidate.label, error: (err as Error).message }, 'D4 reserve pressure failed');
          return {
            score: 50,
            details: {
              collateralUtilizationRatio: 0,
              debtUtilizationRatio: 0,
              weightedUtilizationRatio: 0,
              utilizationScore: 50,
              depositLimit: 0,
              totalSupply: 0,
              remainingCapacity: 0,
              capacityRatio: 0,
              capacityPenalty: 0,
              marketTvlUsd: 0,
              tvlPenalty: 0,
            },
          };
        }),
      ]);

    return {
      dimensions: {
        depegRisk: depegRisk.score,
        liquidationProximity: liquidationProximity.score,
        exitLiquidity: exitLiquidity.score,
        reservePressure: reservePressure.score,
      },
      details: {
        depegRisk: depegRisk.details,
        liquidationProximity: liquidationProximity.details,
        exitLiquidity: exitLiquidity.details,
        reservePressure: reservePressure.details,
      },
    };
  }

  /** Fetch collateral and debt prices from Jupiter (shared by D1 and D2) */
  private async fetchPrices(collToken: string, debtToken: string): Promise<{ collPrice: number; debtPrice: number }> {
    const data = await this.fetchJupiterJson<Record<string, unknown>>(
      JUPITER_PRICE_API_PATH,
      new URLSearchParams({ ids: `${collToken},${debtToken}` }),
    );

    const collPrice = parseJupiterUsdPrice(data[collToken]);
    const debtPrice = parseJupiterUsdPrice(data[debtToken]);
    return { collPrice, debtPrice };
  }

  /**
   * D1: Depeg Risk (30%)
   * Measures peg deviation + 24h volatility + 7-day tail risk.
   */
  private async calcDepegRisk(
    candidate: MultiplyCandidate,
    prices: { collPrice: number; debtPrice: number },
  ): Promise<DimensionResult<RiskDimensionDetails['depegRisk']>> {
    const { collPrice, debtPrice } = prices;

    if (collPrice === 0 || debtPrice === 0) {
      log.warn({ collPrice, debtPrice, label: candidate.label }, 'Missing price data');
      return {
        score: 50,
        details: {
          collPriceUsd: collPrice,
          debtPriceUsd: debtPrice,
          marketRate: 0,
          expectedRate: 0,
          deviationBps: 0,
          spotScore: 50,
          volatility24hBps: 0,
          volatility24hScore: 50,
          volatilitySampleCount: 0,
          tailRisk7dBps: 0,
          tailRisk7dScore: 50,
          tailRiskSampleCount: 0,
        },
      };
    }

    const marketRate = collPrice / debtPrice;
    const [collReferenceUsd, debtReferenceUsd] = await Promise.all([
      this.getReferencePriceUsd(candidate.collToken, collPrice),
      this.getReferencePriceUsd(candidate.debtToken, debtPrice),
    ]);
    const expectedRate = debtReferenceUsd > 0 ? collReferenceUsd / debtReferenceUsd : 1.0;
    const safeExpectedRate = expectedRate > 0 ? expectedRate : 1.0;
    const deviationBps = Math.abs(marketRate - safeExpectedRate) / safeExpectedRate * 10_000;

    // Sub-components
    const spotScore = clamp(deviationBps / this.config.maxDeviationBps * 100);
    const volatility24h = this.getPegVolatility24h(candidate.label);
    const tailRisk7d = this.getPegTailRisk7d(candidate.label);

    const depegRisk = 0.60 * spotScore + 0.25 * volatility24h.score + 0.15 * tailRisk7d.score;

    // Store peg deviation for future volatility/tail calculation
    this.storePegDeviation(candidate.label, deviationBps);

    const score = clamp(depegRisk);

    log.debug(
      {
        label: candidate.label,
        marketRate: marketRate.toFixed(6),
        expectedRate: safeExpectedRate.toFixed(6),
        deviationBps: deviationBps.toFixed(1),
        spotScore: spotScore.toFixed(1),
        volScore: volatility24h.score.toFixed(1),
        tailScore: tailRisk7d.score.toFixed(1),
        depegRisk: score.toFixed(1),
      },
      'D1 Depeg risk',
    );

    return {
      score,
      details: {
        collPriceUsd: collPrice,
        debtPriceUsd: debtPrice,
        marketRate,
        expectedRate: safeExpectedRate,
        deviationBps,
        spotScore,
        volatility24hBps: volatility24h.bps,
        volatility24hScore: volatility24h.score,
        volatilitySampleCount: volatility24h.sampleCount,
        tailRisk7dBps: tailRisk7d.bps,
        tailRisk7dScore: tailRisk7d.score,
        tailRiskSampleCount: tailRisk7d.sampleCount,
      },
    };
  }

  /**
   * D2: Liquidation Proximity (30%)
   * Measures distance to liquidation at target leverage given current prices.
   */
  private async calcLiquidationProximity(
    candidate: MultiplyCandidate,
    prices: { collPrice: number; debtPrice: number },
  ): Promise<DimensionResult<RiskDimensionDetails['liquidationProximity']>> {
    const { collPrice, debtPrice } = prices;
    if (collPrice === 0 || debtPrice === 0) {
      return {
        score: 50,
        details: {
          liquidationLtv: 0,
          targetHealthRate: candidate.targetHealthRate ?? DEFAULT_TARGET_HEALTH_RATE,
          targetLeverage: 0,
          marketRate: 0,
          simulatedHealthRate: 0,
          stressedMarketRate: 0,
          stressedHealthRate: 0,
          baseScore: 50,
          stressScore: 50,
        },
      };
    }

    const market = await this.getOrLoadMarket(candidate.market);
    await market.loadReserves();

    const { liquidationLtv } = market.getMaxAndLiquidationLtvAndBorrowFactorForPair(
      address(candidate.collToken),
      address(candidate.debtToken),
    );
    const liqLtv = typeof liquidationLtv === 'number' ? liquidationLtv : Number(liquidationLtv);

    const targetHealth = candidate.targetHealthRate ?? DEFAULT_TARGET_HEALTH_RATE;
    if (targetHealth <= liqLtv) {
      return {
        score: 100,
        details: {
          liquidationLtv: liqLtv,
          targetHealthRate: targetHealth,
          targetLeverage: 0,
          marketRate: collPrice / debtPrice,
          simulatedHealthRate: 0,
          stressedMarketRate: 0,
          stressedHealthRate: 0,
          baseScore: 100,
          stressScore: 100,
        },
      };
    }

    // Target leverage at perfect peg
    const targetLeverage = targetHealth / (targetHealth - liqLtv);

    // Simulated health at current market rate
    // health = (L * collPrice * liqLtv) / ((L - 1) * debtPrice)
    const marketRate = collPrice / debtPrice;
    const simulatedHealth = (targetLeverage * marketRate * liqLtv) / (targetLeverage - 1);

    // Buffer: how far from liquidation (health = 1.0)
    const maxBuffer = targetHealth - 1.0; // theoretical buffer at perfect peg
    const healthBuffer = Math.max(simulatedHealth - 1.0, 0);
    const baseScore = maxBuffer > 0
      ? clamp((1 - healthBuffer / maxBuffer) * 100)
      : 100;

    // Stress test: double the current depeg
    const currentDepeg = Math.abs(1.0 - marketRate);
    const stressedRate = marketRate > 1.0
      ? 1.0 + 2 * currentDepeg  // if collateral trades above, stress = more above
      : 1.0 - 2 * currentDepeg; // if below, stress = further below
    const stressedHealth = (targetLeverage * stressedRate * liqLtv) / (targetLeverage - 1);
    const stressBuffer = Math.max(stressedHealth - 1.0, 0);
    const stressScore = maxBuffer > 0
      ? clamp((1 - stressBuffer / maxBuffer) * 100)
      : 100;

    const liquidationProximity = 0.70 * baseScore + 0.30 * stressScore;
    const score = clamp(liquidationProximity);

    log.debug(
      {
        label: candidate.label,
        liqLtv: liqLtv.toFixed(4),
        targetLeverage: targetLeverage.toFixed(2),
        marketRate: marketRate.toFixed(6),
        simulatedHealth: simulatedHealth.toFixed(4),
        baseScore: baseScore.toFixed(1),
        stressScore: stressScore.toFixed(1),
        liquidationProximity: score.toFixed(1),
      },
      'D2 Liquidation proximity',
    );

    return {
      score,
      details: {
        liquidationLtv: liqLtv,
        targetHealthRate: targetHealth,
        targetLeverage,
        marketRate,
        simulatedHealthRate: simulatedHealth,
        stressedMarketRate: stressedRate,
        stressedHealthRate: stressedHealth,
        baseScore,
        stressScore,
      },
    };
  }

  /**
   * D3: Exit Liquidity (20%)
   * Measures slippage on emergency exit (full position swap coll → debt).
   */
  private async calcExitLiquidity(
    candidate: MultiplyCandidate,
    positionSizeUsd: number,
  ): Promise<DimensionResult<RiskDimensionDetails['exitLiquidity']>> {
    const { collToken, debtToken } = candidate;
    const collDecimals = candidate.collDecimals ?? 6;

    // Amount in smallest units (assume price ~$1 for stables/RWA)
    const amount = Math.floor(positionSizeUsd * 10 ** collDecimals);
    const params = new URLSearchParams({
      inputMint: collToken,
      outputMint: debtToken,
      amount: amount.toString(),
      slippageBps: '300', // max slippage tolerance
    });

    const quote = await this.fetchJupiterJson<any>(JUPITER_QUOTE_API_PATH, params);

    const priceImpactPct = parseFloat(quote.priceImpactPct ?? '0');
    const slippageBps = Math.abs(priceImpactPct) * 100;
    const score = clamp(slippageBps / this.config.maxSlippageBps * 100);

    log.debug(
      {
        label: candidate.label,
        positionSizeUsd,
        priceImpactPct: priceImpactPct.toFixed(4),
        slippageBps: slippageBps.toFixed(1),
        score: score.toFixed(1),
      },
      'D3 Exit liquidity',
    );

    return {
      score,
      details: {
        assumedExitUsd: positionSizeUsd,
        quoteInputAmount: amount,
        priceImpactPct,
        slippageBps,
      },
    };
  }

  /**
   * D4: Reserve Pressure (20%)
   * Combined reserve utilization + capacity penalty + TVL floor.
   */
  private async calcReservePressure(
    candidate: MultiplyCandidate,
  ): Promise<DimensionResult<RiskDimensionDetails['reservePressure']>> {
    const market = await this.getOrLoadMarket(candidate.market);
    await market.loadReserves();

    const collReserve = market.getReserveByMint(address(candidate.collToken));
    const debtReserve = market.getReserveByMint(address(candidate.debtToken));
    if (!collReserve || !debtReserve) {
      throw new Error(`Reserve not found for ${candidate.label}`);
    }

    // Utilization score
    const collUtil = collReserve.calculateUtilizationRatio();
    const debtUtil = debtReserve.calculateUtilizationRatio();
    const weightedUtil = 0.4 * collUtil + 0.6 * debtUtil;
    const utilizationScore = clamp(weightedUtil / this.config.criticalUtilization * 100);

    // Capacity penalty
    const collDecimals = candidate.collDecimals ?? 6;
    const depositLimit = new Decimal(collReserve.state.config.depositLimit.toString())
      .div(new Decimal(10).pow(collDecimals))
      .toNumber();
    const totalSupply = collReserve.getTotalSupply()
      .div(new Decimal(10).pow(collDecimals))
      .toNumber();
    const remaining = Math.max(depositLimit - totalSupply, 0);
    const capacityRatio = depositLimit > 0 ? remaining / depositLimit : 0;
    const capacityPenalty = capacityRatio < 0.05 ? 30 : capacityRatio < 0.10 ? 15 : 0;

    // TVL floor penalty (discrete steps instead of continuous)
    const collPriceUsd = await this.getTokenPriceUsd(candidate.collToken);
    const debtPriceUsd = await this.getTokenPriceUsd(candidate.debtToken);
    const collTvl = collReserve.getTotalSupply().div(new Decimal(10).pow(collDecimals)).toNumber() * collPriceUsd;
    const debtDecimals = candidate.debtDecimals ?? 6;
    const debtTvl = debtReserve.getTotalSupply().div(new Decimal(10).pow(debtDecimals)).toNumber() * debtPriceUsd;
    const marketTvl = collTvl + debtTvl;

    let tvlPenalty: number;
    if (candidate.minTvlUsdc && marketTvl < candidate.minTvlUsdc) {
      tvlPenalty = 40; // below absolute minimum
    } else if (marketTvl < this.config.tvlSafeThreshold * 0.5) {
      tvlPenalty = 20;
    } else if (marketTvl < this.config.tvlSafeThreshold) {
      tvlPenalty = 10;
    } else {
      tvlPenalty = 0;
    }

    const reservePressure = clamp(utilizationScore + capacityPenalty + tvlPenalty);

    log.debug(
      {
        label: candidate.label,
        collUtil: (collUtil * 100).toFixed(1),
        debtUtil: (debtUtil * 100).toFixed(1),
        capacityRatio: (capacityRatio * 100).toFixed(1),
        capacityPenalty,
        marketTvl: `$${(marketTvl / 1e6).toFixed(2)}M`,
        tvlPenalty,
        reservePressure: reservePressure.toFixed(1),
      },
      'D4 Reserve pressure',
    );

    return {
      score: reservePressure,
      details: {
        collateralUtilizationRatio: collUtil,
        debtUtilizationRatio: debtUtil,
        weightedUtilizationRatio: weightedUtil,
        utilizationScore,
        depositLimit,
        totalSupply,
        remainingCapacity: remaining,
        capacityRatio,
        capacityPenalty,
        marketTvlUsd: marketTvl,
        tvlPenalty,
      },
    };
  }

  // ── Score → Action Mapping ────────────────────────────────

  /**
   * Map composite score to target health rate.
   * 1.12 at score=0, 1.32 at score=100.
   */
  static scoreToHealthRate(score: number): number {
    return 1.12 + (score / 100) * 0.20;
  }

  /**
   * Map composite score to max position cap.
   * Full cap at score=0, 25% cap at score>=75.
   */
  static scoreToPositionCap(score: number, maxCap: number): number {
    return maxCap * Math.max(1 - score / 100, 0.25);
  }

  /**
   * Map composite score to alert level.
   */
  static scoreToAlertLevel(score: number): RiskAlertLevel {
    if (score >= 90) return 'emergency';
    if (score >= 75) return 'critical';
    if (score >= 55) return 'warning';
    return 'normal';
  }

  // ── Helpers ───────────────────────────────────────────────

  private async getOrLoadMarket(marketAddress: string): Promise<KaminoMarket> {
    const cached = this.marketCache.get(marketAddress);
    if (cached && Date.now() - cached.loadedAt < this.MARKET_CACHE_TTL) {
      return cached.market;
    }

    const rpc = createSolanaRpc(this.rpcUrl);
    const market = await KaminoMarket.load(rpc as any, address(marketAddress) as any, DEFAULT_RECENT_SLOT_DURATION_MS);
    if (!market) throw new Error(`Failed to load Kamino market ${marketAddress}`);

    this.marketCache.set(marketAddress, { market, loadedAt: Date.now() });
    return market;
  }

  private async getTokenPriceUsd(mint: string): Promise<number> {
    if (STABLECOIN_MINTS.has(mint)) return 1;
    try {
      const data = await this.fetchJupiterJson<Record<string, unknown>>(
        JUPITER_PRICE_API_PATH,
        new URLSearchParams({ ids: mint }),
      );
      return parseJupiterUsdPrice(data[mint]) || 1;
    } catch {
      return 1;
    }
  }

  private async getReferencePriceUsd(mint: string, spotPriceUsd: number): Promise<number> {
    if (STABLECOIN_MINTS.has(mint)) return 1;

    if (isOnycToken(mint)) {
      try {
        const onyc = await getOnycApy(this.rpcUrl, mint, 0);
        if (onyc.basePrice && onyc.basePrice > 0) {
          return onyc.basePrice;
        }
      } catch (err) {
        log.warn({ mint, error: (err as Error).message }, 'Failed to fetch ONyc reference price');
      }
    }

    return spotPriceUsd > 0 ? spotPriceUsd : await this.getTokenPriceUsd(mint);
  }

  private async fetchJupiterJson<T>(path: string, params: URLSearchParams): Promise<T> {
    const baseUrls = getJupiterApiBaseCandidates();
    let lastError: Error | null = null;

    for (const baseUrl of baseUrls) {
      try {
        const response = await fetch(`${baseUrl}${path}?${params.toString()}`, {
          headers: getJupiterHeaders(baseUrl),
        });
        if (response.ok) {
          return await response.json() as T;
        }

        lastError = new Error(`Jupiter ${path} ${response.status} via ${baseUrl}`);
        if (response.status >= 400 && response.status < 500 && ![401, 403, 404].includes(response.status)) {
          break;
        }
      } catch (err) {
        lastError = err as Error;
      }
    }

    throw lastError ?? new Error(`Jupiter ${path} request failed`);
  }

  /** Get 24h peg deviation volatility from stored data */
  private getPegVolatility24h(label: string): { bps: number; score: number; sampleCount: number } {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare('SELECT peg_deviation_bps FROM multiply_apy_history WHERE label = ? AND timestamp > ? AND peg_deviation_bps IS NOT NULL')
      .all(label, cutoff) as { peg_deviation_bps: number }[];

    if (rows.length < 3) {
      return { bps: 0, score: 50, sampleCount: rows.length };
    }
    const deviations = rows.map((r) => r.peg_deviation_bps);
    const vol = stddev(deviations);
    // Normalize: 50 bps stddev = max score
    return { bps: vol, score: clamp(vol / 50 * 100), sampleCount: rows.length };
  }

  /** Get 7-day max peg deviation (tail risk) */
  private getPegTailRisk7d(label: string): { bps: number; score: number; sampleCount: number } {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const row = this.db
      .prepare('SELECT MAX(peg_deviation_bps) as max_dev, COUNT(*) as sample_count FROM multiply_apy_history WHERE label = ? AND timestamp > ? AND peg_deviation_bps IS NOT NULL')
      .get(label, cutoff) as { max_dev: number | null; sample_count: number } | undefined;

    if (!row?.max_dev) {
      return { bps: 0, score: 50, sampleCount: row?.sample_count ?? 0 };
    }
    return {
      bps: row.max_dev,
      score: clamp(row.max_dev / this.config.maxDeviationBps * 100),
      sampleCount: row.sample_count,
    };
  }

  /** Store peg deviation for future volatility calculation */
  private storePegDeviation(label: string, deviationBps: number): void {
    try {
      this.db
        .prepare('UPDATE multiply_apy_history SET peg_deviation_bps = ? WHERE label = ? AND id = (SELECT MAX(id) FROM multiply_apy_history WHERE label = ?)')
        .run(deviationBps, label, label);
    } catch { /* best effort */ }
  }

  private persistAssessment(assessment: RiskAssessment): void {
    try {
      this.insertRiskStmt?.run(
        assessment.label,
        assessment.compositeScore,
        assessment.dimensions.depegRisk,
        assessment.dimensions.liquidationProximity,
        assessment.dimensions.exitLiquidity,
        assessment.dimensions.reservePressure,
        assessment.riskPenalty,
        assessment.targetHealthRate,
        assessment.maxPositionCap,
        assessment.alertLevel,
        assessment.assessedAt,
      );
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to persist risk assessment');
    }
  }

  /** Get historical risk scores for a label */
  getHistoricalScores(label: string, hours: number = 24): RiskAssessment[] {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const rows = this.db
      .prepare('SELECT * FROM multiply_risk_scores WHERE label = ? AND timestamp > ? ORDER BY timestamp ASC')
      .all(label, cutoff) as any[];

    return rows.map((r) => ({
      label: r.label,
      compositeScore: r.composite_score,
      dimensions: {
        depegRisk: r.depeg_risk ?? r.peg_stability ?? 0,
        liquidationProximity: r.liquidation_proximity ?? 0,
        exitLiquidity: r.exit_liquidity ?? r.liquidity_depth ?? 0,
        reservePressure: r.reserve_pressure ?? r.reserve_utilization ?? 0,
      },
      details: {
        depegRisk: {
          collPriceUsd: 0,
          debtPriceUsd: 0,
          marketRate: 0,
          expectedRate: 0,
          deviationBps: 0,
          spotScore: r.depeg_risk ?? r.peg_stability ?? 0,
          volatility24hBps: 0,
          volatility24hScore: 0,
          volatilitySampleCount: 0,
          tailRisk7dBps: 0,
          tailRisk7dScore: 0,
          tailRiskSampleCount: 0,
        },
        liquidationProximity: {
          liquidationLtv: 0,
          targetHealthRate: r.target_health_rate,
          targetLeverage: 0,
          marketRate: 0,
          simulatedHealthRate: 0,
          stressedMarketRate: 0,
          stressedHealthRate: 0,
          baseScore: 0,
          stressScore: 0,
        },
        exitLiquidity: {
          assumedExitUsd: 0,
          quoteInputAmount: 0,
          priceImpactPct: 0,
          slippageBps: 0,
        },
        reservePressure: {
          collateralUtilizationRatio: 0,
          debtUtilizationRatio: 0,
          weightedUtilizationRatio: 0,
          utilizationScore: 0,
          depositLimit: 0,
          totalSupply: 0,
          remainingCapacity: 0,
          capacityRatio: 0,
          capacityPenalty: 0,
          marketTvlUsd: 0,
          tvlPenalty: 0,
        },
      },
      riskPenalty: r.risk_penalty,
      targetHealthRate: r.target_health_rate,
      maxPositionCap: r.max_position_cap,
      alertLevel: r.alert_level as RiskAlertLevel,
      assessedAt: r.timestamp,
    }));
  }

  /**
   * Detect if a risk score jump warrants an alert.
   * Returns true if score increased by more than 15 points since last assessment.
   */
  detectScoreJump(label: string, currentScore: number): boolean {
    const rows = this.db
      .prepare('SELECT composite_score FROM multiply_risk_scores WHERE label = ? ORDER BY timestamp DESC LIMIT 1 OFFSET 1')
      .all(label) as { composite_score: number }[];

    if (rows.length === 0) return false;
    return currentScore - rows[0]!.composite_score > 15;
  }

  getRejectThreshold(): number {
    return this.config.rejectThreshold;
  }

  getEmergencyThreshold(): number {
    return this.config.emergencyThreshold;
  }
}
