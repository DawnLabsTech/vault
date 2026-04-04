/**
 * Quantitative risk scorer for Kamino Multiply pairs.
 *
 * Computes a composite risk score (0-100) from 6 independently measurable dimensions:
 *   D1: Peg Stability (25%) — collateral/debt price deviation
 *   D2: Liquidity Depth (20%) — swap slippage on emergency exit
 *   D3: Reserve Utilization (20%) — Kamino reserve pressure
 *   D4: TVL / Protocol (15%) — market size / maturity
 *   D5: Borrow Rate Volatility (10%) — borrow cost instability
 *   D6: Collateral Type (10%) — token age / holder distribution
 *
 * The composite score maps to operational parameters:
 *   - Risk penalty (APY deduction)
 *   - Target health rate
 *   - Max position cap
 *   - Alert level
 */
import { createChildLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { KaminoMarket, DEFAULT_RECENT_SLOT_DURATION_MS } from '@kamino-finance/klend-sdk';
import { createSolanaRpc, address } from '@solana/kit';
import Decimal from 'decimal.js';
import type Database from 'better-sqlite3';
import type {
  MultiplyCandidate,
  RiskDimensionScores,
  RiskAssessment,
  RiskAlertLevel,
  RiskScorerConfig,
} from '../types.js';
import { isOnycToken } from '../connectors/defi/onre-apy.js';

const log = createChildLogger('multiply-risk-scorer');

const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2';
const JUPITER_QUOTE_API = 'https://api.jup.ag/swap/v1/quote';

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

/** Standard deviation of an array of numbers */
function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export class MultiplyRiskScorer {
  private rpcUrl: string;
  private config: RiskScorerConfig;
  private db: Database.Database;

  // Cached Kamino markets (keyed by market address)
  private marketCache: Map<string, { market: KaminoMarket; loadedAt: number }> = new Map();
  private readonly MARKET_CACHE_TTL = 5 * 60 * 1000; // 5 min

  // Cached D6 collateral type scores (keyed by collToken, refreshed daily)
  private collTypeCache: Map<string, { score: number; fetchedAt: number }> = new Map();
  private readonly COLL_TYPE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

  // EMA smoothed composite scores
  private emaScores: Map<string, number> = new Map();

  private insertRiskStmt: Database.Statement | null = null;
  private insertApyDetailStmt: Database.Statement | null = null;

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

    this.insertRiskStmt = this.db.prepare(`
      INSERT INTO multiply_risk_scores
        (label, composite_score, peg_stability, liquidity_depth, reserve_utilization,
         tvl_protocol, borrow_rate_vol, collateral_type, risk_penalty,
         target_health_rate, max_position_cap, alert_level, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const dimensions = await this.computeDimensions(candidate, maxPositionCapUsd);
    const w = this.config.weights;

    const rawScore =
      w.pegStability * dimensions.pegStability +
      w.liquidityDepth * dimensions.liquidityDepth +
      w.reserveUtilization * dimensions.reserveUtilization +
      w.tvlProtocol * dimensions.tvlProtocol +
      w.borrowRateVol * dimensions.borrowRateVol +
      w.collateralType * dimensions.collateralType;

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
      riskPenalty: MultiplyRiskScorer.scoreToRiskPenalty(compositeScore),
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
        d1: dimensions.pegStability.toFixed(1),
        d2: dimensions.liquidityDepth.toFixed(1),
        d3: dimensions.reserveUtilization.toFixed(1),
        d4: dimensions.tvlProtocol.toFixed(1),
        d5: dimensions.borrowRateVol.toFixed(1),
        d6: dimensions.collateralType.toFixed(1),
        penalty: `${(assessment.riskPenalty * 100).toFixed(2)}%`,
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
  ): Promise<RiskDimensionScores> {
    const [pegStability, liquidityDepth, reserveAndTvl, borrowRateVol, collateralType] =
      await Promise.all([
        this.calcPegStability(candidate).catch((err) => {
          log.warn({ label: candidate.label, error: (err as Error).message }, 'D1 peg stability failed');
          return 50; // conservative default
        }),
        this.calcLiquidityDepth(candidate, maxPositionCapUsd).catch((err) => {
          log.warn({ label: candidate.label, error: (err as Error).message }, 'D2 liquidity depth failed');
          return 50;
        }),
        this.calcReserveAndTvl(candidate).catch((err) => {
          log.warn({ label: candidate.label, error: (err as Error).message }, 'D3+D4 reserve/TVL failed');
          return { reserveUtilization: 50, tvlProtocol: 50 };
        }),
        this.calcBorrowRateVol(candidate.label).catch((err) => {
          log.warn({ label: candidate.label, error: (err as Error).message }, 'D5 borrow vol failed');
          return 50;
        }),
        this.calcCollateralType(candidate).catch((err) => {
          log.warn({ label: candidate.label, error: (err as Error).message }, 'D6 collateral type failed');
          return 50;
        }),
      ]);

    return {
      pegStability,
      liquidityDepth,
      reserveUtilization: typeof reserveAndTvl === 'number' ? reserveAndTvl : reserveAndTvl.reserveUtilization,
      tvlProtocol: typeof reserveAndTvl === 'number' ? reserveAndTvl : reserveAndTvl.tvlProtocol,
      borrowRateVol,
      collateralType,
    };
  }

  /**
   * D1: Peg Stability Risk (25%)
   * Measures deviation between collateral and debt token's expected exchange rate.
   */
  private async calcPegStability(candidate: MultiplyCandidate): Promise<number> {
    const { collToken, debtToken } = candidate;

    // Fetch market prices from Jupiter
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${collToken},${debtToken}`);
    if (!res.ok) throw new Error(`Jupiter price API ${res.status}`);
    const data = (await res.json()) as any;

    const collPrice = parseFloat(data.data?.[collToken]?.price ?? '0');
    const debtPrice = parseFloat(data.data?.[debtToken]?.price ?? '0');

    if (collPrice === 0 || debtPrice === 0) {
      log.warn({ collPrice, debtPrice, label: candidate.label }, 'Missing price data');
      return 50; // conservative
    }

    const marketRate = collPrice / debtPrice;

    // Expected rate: for stable/stable pairs = 1.0, for RWA/stable = NAV-based
    // For simplicity, RWA tokens pegged to USD should also trade near 1.0 relative to stables
    const expectedRate = 1.0;
    const deviationBps = Math.abs(marketRate - expectedRate) / expectedRate * 10_000;

    // Also compute 24h volatility from stored data
    const volScore = this.getPegVolatility24h(candidate.label);

    const currentScore = clamp(deviationBps / this.config.maxDeviationBps * 100);
    const pegScore = 0.6 * currentScore + 0.4 * volScore;

    // Store peg deviation for future volatility calculation
    this.storePegDeviation(candidate.label, deviationBps);

    log.debug(
      {
        label: candidate.label,
        marketRate: marketRate.toFixed(6),
        deviationBps: deviationBps.toFixed(1),
        volScore: volScore.toFixed(1),
        pegScore: pegScore.toFixed(1),
      },
      'D1 Peg stability',
    );

    return clamp(pegScore);
  }

  /**
   * D2: Liquidity Depth Risk (20%)
   * Measures slippage on emergency exit (full position swap coll → debt).
   */
  private async calcLiquidityDepth(
    candidate: MultiplyCandidate,
    positionSizeUsd: number,
  ): Promise<number> {
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

    const res = await fetch(`${JUPITER_QUOTE_API}?${params}`);
    if (!res.ok) throw new Error(`Jupiter quote API ${res.status}`);
    const quote = (await res.json()) as any;

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
      'D2 Liquidity depth',
    );

    return score;
  }

  /**
   * D3 + D4: Reserve Utilization (20%) + TVL/Protocol Risk (15%)
   * Combined because they share the same Kamino market load.
   */
  private async calcReserveAndTvl(
    candidate: MultiplyCandidate,
  ): Promise<{ reserveUtilization: number; tvlProtocol: number }> {
    const market = await this.getOrLoadMarket(candidate.market);
    await market.loadReserves();

    const collReserve = market.getReserveByMint(address(candidate.collToken));
    const debtReserve = market.getReserveByMint(address(candidate.debtToken));
    if (!collReserve || !debtReserve) {
      throw new Error(`Reserve not found for ${candidate.label}`);
    }

    // D3: Reserve Utilization
    const collUtil = collReserve.calculateUtilizationRatio();
    const debtUtil = debtReserve.calculateUtilizationRatio();
    const weightedUtil = 0.4 * collUtil + 0.6 * debtUtil;
    let utilizationScore = clamp(weightedUtil / this.config.criticalUtilization * 100);

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
    const reserveScore = clamp(utilizationScore + capacityPenalty);

    // D4: TVL / Protocol Risk
    // Fetch prices for TVL calculation
    const collPriceUsd = await this.getTokenPriceUsd(candidate.collToken);
    const debtPriceUsd = await this.getTokenPriceUsd(candidate.debtToken);
    const collTvl = collReserve.getTotalSupply().div(new Decimal(10).pow(collDecimals)).toNumber() * collPriceUsd;
    const debtDecimals = candidate.debtDecimals ?? 6;
    const debtTvl = debtReserve.getTotalSupply().div(new Decimal(10).pow(debtDecimals)).toNumber() * debtPriceUsd;
    const marketTvl = collTvl + debtTvl;

    let tvlScore: number;
    if (candidate.minTvlUsdc && marketTvl < candidate.minTvlUsdc) {
      tvlScore = 100; // reject: below minimum
    } else {
      tvlScore = clamp((1 - marketTvl / this.config.tvlSafeThreshold) * 100);
    }

    log.debug(
      {
        label: candidate.label,
        collUtil: (collUtil * 100).toFixed(1),
        debtUtil: (debtUtil * 100).toFixed(1),
        capacityRatio: (capacityRatio * 100).toFixed(1),
        reserveScore: reserveScore.toFixed(1),
        marketTvl: `$${(marketTvl / 1e6).toFixed(2)}M`,
        tvlScore: tvlScore.toFixed(1),
      },
      'D3+D4 Reserve/TVL',
    );

    return { reserveUtilization: reserveScore, tvlProtocol: tvlScore };
  }

  /**
   * D5: Borrow Rate Volatility (10%)
   * Standard deviation of borrow APY samples over 24h.
   */
  private async calcBorrowRateVol(label: string): Promise<number> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare('SELECT borrow_apy FROM multiply_apy_history WHERE label = ? AND timestamp > ? AND borrow_apy IS NOT NULL')
      .all(label, cutoff) as { borrow_apy: number }[];

    // Cold start: need at least 6 data points (36h at 6h intervals)
    if (rows.length < 6) {
      log.debug({ label, sampleCount: rows.length }, 'D5 insufficient data, using default');
      return 50; // conservative default
    }

    const borrowRates = rows.map((r) => r.borrow_apy);
    const vol = stddev(borrowRates);
    const score = clamp(vol / this.config.maxBorrowVol * 100);

    log.debug(
      {
        label,
        sampleCount: rows.length,
        borrowVol: (vol * 100).toFixed(2),
        score: score.toFixed(1),
      },
      'D5 Borrow rate volatility',
    );

    return score;
  }

  /**
   * D6: Collateral Type Risk (10%)
   * Token age and holder count. Cached 24h.
   */
  private async calcCollateralType(candidate: MultiplyCandidate): Promise<number> {
    const cached = this.collTypeCache.get(candidate.collToken);
    if (cached && Date.now() - cached.fetchedAt < this.COLL_TYPE_CACHE_TTL) {
      return cached.score;
    }

    // Both tokens are stablecoins → low structural risk
    const isStablePair =
      STABLECOIN_MINTS.has(candidate.collToken) && STABLECOIN_MINTS.has(candidate.debtToken);

    let agePenalty = 0;
    let holderPenalty = 0;

    if (!STABLECOIN_MINTS.has(candidate.collToken)) {
      // Try Helius getAsset for token metadata
      try {
        const assetInfo = await this.fetchTokenInfo(candidate.collToken);
        if (assetInfo.createdAtMs) {
          const ageMonths = (Date.now() - assetInfo.createdAtMs) / (30 * 24 * 60 * 60 * 1000);
          agePenalty = ageMonths < 3 ? 40 : ageMonths < 6 ? 20 : ageMonths < 12 ? 10 : 0;
        }
        if (assetInfo.holderCount !== undefined) {
          holderPenalty = assetInfo.holderCount < 100 ? 40
            : assetInfo.holderCount < 500 ? 20
              : assetInfo.holderCount < 1000 ? 10
                : 0;
        }
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'Failed to fetch token info for D6');
        agePenalty = 20; // moderate default
        holderPenalty = 20;
      }
    }

    const stablePairBonus = isStablePair ? -20 : 0;
    const score = clamp(agePenalty + holderPenalty + stablePairBonus);

    this.collTypeCache.set(candidate.collToken, { score, fetchedAt: Date.now() });

    log.debug(
      {
        label: candidate.label,
        isStablePair,
        agePenalty,
        holderPenalty,
        stablePairBonus,
        score: score.toFixed(1),
      },
      'D6 Collateral type',
    );

    return score;
  }

  // ── Score → Action Mapping ────────────────────────────────

  /**
   * Map composite score to APY risk penalty (decimal).
   * 0 at score<=15, linear up to ~3.4% at score=100.
   */
  static scoreToRiskPenalty(score: number): number {
    if (score <= 15) return 0;
    return (score - 15) * 0.0004;
  }

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
      const res = await fetch(`${JUPITER_PRICE_API}?ids=${mint}`);
      if (!res.ok) return 1;
      const data = (await res.json()) as any;
      return parseFloat(data.data?.[mint]?.price ?? '1');
    } catch {
      return 1;
    }
  }

  private async fetchTokenInfo(
    mint: string,
  ): Promise<{ createdAtMs?: number; holderCount?: number }> {
    // Use Helius DAS API if available via RPC
    const heliusApiKey = process.env.HELIUS_API_KEY;
    if (!heliusApiKey) {
      return {};
    }

    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'risk-scorer',
        method: 'getAsset',
        params: { id: mint },
      }),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as any;

    const createdAtMs = data.result?.content?.metadata?.created_at
      ? new Date(data.result.content.metadata.created_at).getTime()
      : undefined;

    // Holder count from a separate endpoint
    let holderCount: number | undefined;
    try {
      const holdersRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'risk-scorer-holders',
          method: 'getTokenAccounts',
          params: { mint, limit: 1, page: 1 },
        }),
      });
      if (holdersRes.ok) {
        const holdersData = (await holdersRes.json()) as any;
        holderCount = holdersData.result?.total;
      }
    } catch { /* ignore */ }

    return { createdAtMs, holderCount };
  }

  /** Get 24h peg deviation volatility from stored data */
  private getPegVolatility24h(label: string): number {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare('SELECT peg_deviation_bps FROM multiply_apy_history WHERE label = ? AND timestamp > ? AND peg_deviation_bps IS NOT NULL')
      .all(label, cutoff) as { peg_deviation_bps: number }[];

    if (rows.length < 3) return 50; // cold start default
    const deviations = rows.map((r) => r.peg_deviation_bps);
    const vol = stddev(deviations);
    // Normalize: 50 bps stddev = max score
    return clamp(vol / 50 * 100);
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
        assessment.dimensions.pegStability,
        assessment.dimensions.liquidityDepth,
        assessment.dimensions.reserveUtilization,
        assessment.dimensions.tvlProtocol,
        assessment.dimensions.borrowRateVol,
        assessment.dimensions.collateralType,
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
        pegStability: r.peg_stability,
        liquidityDepth: r.liquidity_depth,
        reserveUtilization: r.reserve_utilization,
        tvlProtocol: r.tvl_protocol,
        borrowRateVol: r.borrow_rate_vol,
        collateralType: r.collateral_type,
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
}
