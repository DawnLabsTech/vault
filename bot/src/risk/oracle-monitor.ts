/**
 * Oracle Anomaly Monitor — cross-checks the prices Kamino uses for
 * liquidation against independent reference sources, and flags conditions
 * that would cause incorrect health-rate evaluation.
 *
 * Phase 1: Kamino on-chain oracle reading.
 *   - Stable-asset peg check (USDC oracle vs $1.00).
 *   - Kamino-internal stale-cache check (stored vs oracle delta).
 *
 * Phase 2: Jupiter Quote API as DEX execution price source.
 *   - Cross-source check between Kamino's implied collateral/debt ratio and
 *     the realized DEX swap price.
 *   - Directional emphasis: if Kamino over-prices collateral relative to the
 *     DEX, our health-rate is silently inflated and real liquidation buffer is
 *     smaller than reported — tightest threshold, critical action.
 *
 * Phase 3: Pyth Hermes for staleness / confidence checks.
 *   - Read Pyth's latest price feed for each configured asset via the Hermes
 *     HTTP endpoint.
 *   - Warn when publishTime is too old (oracle stalled or RPC propagation
 *     issue) or when confidence/price is too wide (oracle uncertain — common
 *     in low-liquidity / outage scenarios).
 *
 * Phase 4 (this revision): sustained-N-samples gate before critical actions fire.
 *   - Critical events emit each cycle but only carry `sustained=true` after the
 *     condition has held for `sustainedSamples` consecutive checks.
 *   - The orchestrator must gate destructive actions (trip / deleverage) on
 *     `sustained === true` to avoid acting on transient fetch glitches.
 *
 * Output: events; the orchestrator decides what action to take per event
 * (alert only, trip circuit breaker, emergency deleverage).
 */
import { createChildLogger } from '../utils/logger.js';
import { sendAlert } from '../utils/notify.js';
import type { OracleMonitorConfig } from '../types.js';

const log = createChildLogger('oracle-monitor');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Stablecoins we treat as $1.00-pegged for the depeg check.
const PEGGED_STABLECOINS = new Set<string>([
  USDC_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
]);

export const DEFAULT_ORACLE_MONITOR_CONFIG: OracleMonitorConfig = {
  checkIntervalMs: 300_000,
  sustainedSamples: 3,
  usdcDeviationWarnBps: 50,
  usdcDeviationCriticalBps: 100,
  kaminoStaleStoredBps: 100,
  onycCrossSourceWarnBps: 50,
  onycCrossSourceCriticalBps: 100,
  onycOverpriceCriticalBps: 75,
  pythStalenessSec: 60,
  pythConfidencePct: 1.0,
  alertCooldownMs: 1_800_000,
};

/**
 * Anomaly kinds. Each maps to a different decision in the orchestrator:
 *   - `stable-depeg`     : NAV-wide impact → trip all protocols.
 *   - `kamino-stale`     : Kamino-internal cache stale → alert; market-specific.
 *   - `cross-source-dev` : ONyc/collateral cross-source divergence (added in Phase 2).
 *   - `pyth-stale`       : Pyth publishTime too old (added in Phase 3).
 *   - `pyth-confidence`  : Pyth confidence interval too wide (added in Phase 3).
 */
export type OracleAnomalyKind =
  | 'stable-depeg'
  | 'kamino-stale'
  | 'cross-source-dev'
  | 'pyth-stale'
  | 'pyth-confidence';

export interface OracleAnomalyEvent {
  kind: OracleAnomalyKind;
  severity: 'warning' | 'critical';
  /** Market label (e.g. "ONyc/USDC") or `*` for shared/all-market events. */
  market: string;
  /** Mint address of the affected asset, when applicable. */
  mint?: string;
  message: string;
  data: Record<string, unknown>;
  timestamp: number;
  /**
   * For critical events only: true once the condition has held for
   * `sustainedSamples` consecutive checks. The orchestrator must gate
   * destructive actions (deleverage / trip) on this flag, since a single
   * critical-threshold sample is often a transient fetch glitch.
   *
   * Always undefined for warning events.
   */
  sustained?: boolean;
  /** Current consecutive critical-sample count (for diagnostics). */
  consecutiveCount?: number;
}

/**
 * Minimal interface OracleMonitor needs from each Multiply market.
 * Decoupled from KaminoMultiplyLending so tests can mock easily.
 */
export interface OracleMarketSource {
  /** Human label for events/logs (e.g. "ONyc/USDC"). */
  label: string;
  /**
   * Returns oracle (fresh) and stored (cached, used for liquidation) prices
   * for both collateral and debt reserves of the market, plus token decimals
   * (needed to denominate Jupiter quote requests).
   */
  getOraclePrices(): Promise<{
    label: string;
    coll: { mint: string; decimals: number; oracle: number; stored: number };
    debt: { mint: string; decimals: number; oracle: number; stored: number };
  }>;
}

/**
 * DEX-execution price source. Implementations call Jupiter (or any aggregator)
 * to get the realized swap price for a small reference amount.
 */
export interface JupiterQuoteSource {
  /**
   * @returns price expressed as `outputMint per 1 unit of inputMint` (in human
   *   units, not lamports), or null if the quote could not be obtained.
   */
  quotePrice(opts: {
    inputMint: string;
    outputMint: string;
    inputAmountHuman: number;
    inputDecimals: number;
    outputDecimals: number;
  }): Promise<number | null>;
}

/**
 * Default Jupiter Quote API implementation. Uses the v1 swap quote endpoint
 * with a tight slippage tolerance — we're only reading the *quote*, not
 * executing, so slippageBps mostly controls route selection.
 *
 * Returns the realized output/input ratio (in human units).
 */
export const defaultJupiterQuoteSource: JupiterQuoteSource = {
  async quotePrice({ inputMint, outputMint, inputAmountHuman, inputDecimals, outputDecimals }) {
    if (!Number.isFinite(inputAmountHuman) || inputAmountHuman <= 0) return null;
    const baseUnits = Math.floor(inputAmountHuman * Math.pow(10, inputDecimals));
    if (baseUnits <= 0) return null;
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: baseUnits.toString(),
      slippageBps: '50',
    });
    const headers: Record<string, string> = {};
    const apiKey = process.env.JUPITER_API_KEY;
    if (apiKey) headers['x-api-key'] = apiKey;
    try {
      const res = await fetch(`https://api.jup.ag/swap/v1/quote?${params}`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        log.debug({ status: res.status, inputMint, outputMint }, 'Jupiter quote non-200');
        return null;
      }
      const data = (await res.json()) as { inAmount?: string; outAmount?: string };
      if (!data.inAmount || !data.outAmount) return null;
      const inHuman = Number(data.inAmount) / Math.pow(10, inputDecimals);
      const outHuman = Number(data.outAmount) / Math.pow(10, outputDecimals);
      if (inHuman <= 0 || outHuman <= 0) return null;
      return outHuman / inHuman;
    } catch (err) {
      log.debug({ error: (err as Error).message, inputMint, outputMint }, 'Jupiter quote failed');
      return null;
    }
  },
};

/**
 * Reference amount for Jupiter cross-source quotes. Small enough that price
 * impact is negligible on healthy pools, large enough to clear minimum
 * routing thresholds. ~$100 of input.
 */
const JUPITER_QUOTE_REFERENCE_USD = 100;

/**
 * Pyth price feed reading. publishTime is in seconds since unix epoch.
 */
export interface PythReading {
  price: number;
  confidence: number;
  publishTime: number;
}

export interface PythPriceSource {
  /** @returns latest Pyth reading for the given price feed id (hex), or null. */
  getPrice(priceId: string): Promise<PythReading | null>;
}

/**
 * Default Pyth source backed by Hermes HTTP. No SDK dependency required.
 * Endpoint: https://hermes.pyth.network/v2/updates/price/latest
 */
export const defaultPythSource: PythPriceSource = {
  async getPrice(priceId) {
    const id = priceId.startsWith('0x') ? priceId.slice(2) : priceId;
    const params = new URLSearchParams();
    params.append('ids[]', id);
    try {
      const res = await fetch(
        `https://hermes.pyth.network/v2/updates/price/latest?${params}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) {
        log.debug({ status: res.status, priceId }, 'Pyth Hermes non-200');
        return null;
      }
      const data = (await res.json()) as {
        parsed?: Array<{
          price?: { price: string; conf: string; expo: number; publish_time: number };
        }>;
      };
      const parsed = data.parsed?.[0]?.price;
      if (!parsed) return null;
      const expoFactor = Math.pow(10, parsed.expo);
      const price = Number(parsed.price) * expoFactor;
      const confidence = Number(parsed.conf) * expoFactor;
      if (!Number.isFinite(price) || price <= 0) return null;
      return { price, confidence, publishTime: parsed.publish_time };
    } catch (err) {
      log.debug({ error: (err as Error).message, priceId }, 'Pyth Hermes fetch failed');
      return null;
    }
  },
};

export class OracleMonitor {
  private config: OracleMonitorConfig;
  private markets: OracleMarketSource[];
  private jupiterQuote: JupiterQuoteSource | null;
  private pythSource: PythPriceSource | null;
  /** mint → Pyth price feed id (hex). Asset goes unmonitored by Pyth if absent. */
  private pythPriceIds: Map<string, string>;

  /** Per (kind:market:mint:severity) cooldown timestamp. */
  private lastAlerts = new Map<string, number>();

  /**
   * Per (kind:market:mint) consecutive critical-sample count. Cleared
   * by `clearSustained()` only when a check definitively confirms the
   * condition is no longer met — transient fetch failures preserve state.
   */
  private criticalSampleCounts = new Map<string, number>();

  constructor(opts: {
    markets: OracleMarketSource[];
    config?: Partial<OracleMonitorConfig>;
    jupiterQuote?: JupiterQuoteSource | null;
    pythSource?: PythPriceSource | null;
    pythPriceIds?: Record<string, string>;
  }) {
    this.config = { ...DEFAULT_ORACLE_MONITOR_CONFIG, ...(opts.config ?? {}) };
    this.markets = opts.markets;
    this.jupiterQuote = opts.jupiterQuote ?? null;
    this.pythSource = opts.pythSource ?? null;
    this.pythPriceIds = new Map(Object.entries(opts.pythPriceIds ?? {}));
  }

  /**
   * Run a single check cycle. Returns all events (warning + critical) emitted
   * after cooldown filtering.
   */
  async check(): Promise<OracleAnomalyEvent[]> {
    const events: OracleAnomalyEvent[] = [];
    const now = Date.now();

    for (const market of this.markets) {
      let prices;
      try {
        prices = await market.getOraclePrices();
      } catch (err) {
        log.warn(
          { market: market.label, error: (err as Error).message },
          'Failed to read oracle prices',
        );
        continue;
      }

      // Both sides of the market: collateral and debt.
      for (const side of [prices.coll, prices.debt]) {
        // 1. Stable depeg check
        const depegEvent = this.checkStableDepeg(market.label, side, now);
        if (depegEvent) events.push(depegEvent);

        // 2. Kamino stored-vs-oracle stale-cache check
        const staleEvent = this.checkKaminoStale(market.label, side, now);
        if (staleEvent) events.push(staleEvent);
      }

      // 3. Cross-source check: Kamino implied ratio vs DEX execution price.
      const crossEvent = await this.checkCrossSource(prices, now);
      if (crossEvent) events.push(crossEvent);

      // 4. Pyth health check: staleness + confidence — for any side that
      //    has a configured Pyth price feed.
      for (const side of [prices.coll, prices.debt]) {
        const pythEvents = await this.checkPythHealth(prices.label, side, now);
        events.push(...pythEvents);
      }
    }

    return events;
  }

  /** Build the key used for sustained-counter and cooldown bookkeeping. */
  private sustainedKey(kind: OracleAnomalyKind, market: string, mint?: string): string {
    return `${kind}:${market}:${mint ?? ''}`;
  }

  /** Clear the sustained counter when a check confirms the critical condition is no longer met. */
  private clearSustained(key: string): void {
    this.criticalSampleCounts.delete(key);
  }

  /**
   * Compare Kamino's implied collateral/debt ratio with the realized DEX swap
   * price for the same pair. If they diverge, one side is mis-priced — and
   * the asymmetric concern is the collateral being over-priced by the oracle
   * (silent erosion of liquidation buffer).
   *
   * Skipped if no Jupiter source was wired or both sides are stablecoins
   * (the peg check covers those). For non-stable collateral pairs we quote
   * collateral → debt, since the dangerous direction is collateral over-pricing.
   */
  private async checkCrossSource(
    prices: {
      label: string;
      coll: { mint: string; decimals: number; oracle: number; stored: number };
      debt: { mint: string; decimals: number; oracle: number; stored: number };
    },
    now: number,
  ): Promise<OracleAnomalyEvent | null> {
    if (!this.jupiterQuote) return null;
    const { coll, debt } = prices;
    if (PEGGED_STABLECOINS.has(coll.mint)) return null;
    if (!Number.isFinite(coll.oracle) || coll.oracle <= 0) return null;
    if (!Number.isFinite(debt.oracle) || debt.oracle <= 0) return null;

    // ~$100 worth of collateral. Avoids dust failure modes and is small enough
    // that price impact on a healthy pool is negligible.
    const inputAmountHuman = JUPITER_QUOTE_REFERENCE_USD / coll.oracle;
    if (!Number.isFinite(inputAmountHuman) || inputAmountHuman <= 0) return null;

    const dexPrice = await this.jupiterQuote.quotePrice({
      inputMint: coll.mint,
      outputMint: debt.mint,
      inputAmountHuman,
      inputDecimals: coll.decimals,
      outputDecimals: debt.decimals,
    });
    // Quote failure: do not change sustained state — could be a transient
    // Jupiter API hiccup, not a confirmed "no anomaly".
    if (dexPrice === null || dexPrice <= 0) return null;

    // Kamino's implied debt-per-collateral ratio (using both oracles):
    //   collOracleUsd / debtOracleUsd
    const kaminoRatio = coll.oracle / debt.oracle;
    const deviationBps = Math.abs(kaminoRatio - dexPrice) / dexPrice * 10_000;

    // Direction: positive => Kamino over-prices collateral (vs. DEX).
    const overpriceBps = ((kaminoRatio - dexPrice) / dexPrice) * 10_000;

    const sKey = this.sustainedKey('cross-source-dev', prices.label, coll.mint);
    const meetsCritical =
      overpriceBps >= this.config.onycOverpriceCriticalBps ||
      deviationBps >= this.config.onycCrossSourceCriticalBps;
    if (!meetsCritical) {
      this.clearSustained(sKey);
    }

    if (overpriceBps >= this.config.onycOverpriceCriticalBps) {
      return this.emit({
        kind: 'cross-source-dev',
        severity: 'critical',
        market: prices.label,
        mint: coll.mint,
        message: `Kamino over-prices ${this.shortMint(coll.mint)} by ${overpriceBps.toFixed(0)}bps vs DEX (Kamino ${kaminoRatio.toFixed(4)} > Jupiter ${dexPrice.toFixed(4)})`,
        data: {
          deviationBps,
          overpriceBps,
          kaminoRatio,
          dexPrice,
          collOraclePrice: coll.oracle,
          debtOraclePrice: debt.oracle,
          direction: 'kamino-over-dex',
        },
        timestamp: now,
      });
    }

    if (deviationBps >= this.config.onycCrossSourceCriticalBps) {
      return this.emit({
        kind: 'cross-source-dev',
        severity: 'critical',
        market: prices.label,
        mint: coll.mint,
        message: `Cross-source divergence ${deviationBps.toFixed(0)}bps on ${this.shortMint(coll.mint)} (Kamino ${kaminoRatio.toFixed(4)} vs Jupiter ${dexPrice.toFixed(4)})`,
        data: {
          deviationBps,
          overpriceBps,
          kaminoRatio,
          dexPrice,
          collOraclePrice: coll.oracle,
          debtOraclePrice: debt.oracle,
          direction: kaminoRatio > dexPrice ? 'kamino-over-dex' : 'dex-over-kamino',
        },
        timestamp: now,
      });
    }

    if (deviationBps >= this.config.onycCrossSourceWarnBps) {
      return this.emit({
        kind: 'cross-source-dev',
        severity: 'warning',
        market: prices.label,
        mint: coll.mint,
        message: `Cross-source divergence ${deviationBps.toFixed(0)}bps on ${this.shortMint(coll.mint)} (Kamino ${kaminoRatio.toFixed(4)} vs Jupiter ${dexPrice.toFixed(4)})`,
        data: {
          deviationBps,
          overpriceBps,
          kaminoRatio,
          dexPrice,
          collOraclePrice: coll.oracle,
          debtOraclePrice: debt.oracle,
          direction: kaminoRatio > dexPrice ? 'kamino-over-dex' : 'dex-over-kamino',
        },
        timestamp: now,
      });
    }

    return null;
  }

  /**
   * Pyth health checks: staleness (publishTime too old) and confidence
   * (conf/price ratio too wide).
   *
   * Both emit `warning` by default; the orchestrator can promote to critical
   * via the sustained-N-samples gate added in Phase 4.
   */
  private async checkPythHealth(
    marketLabel: string,
    side: { mint: string },
    now: number,
  ): Promise<OracleAnomalyEvent[]> {
    if (!this.pythSource) return [];
    const priceId = this.pythPriceIds.get(side.mint);
    if (!priceId) return [];

    const reading = await this.pythSource.getPrice(priceId);
    if (!reading) return [];

    const events: OracleAnomalyEvent[] = [];

    const stalenessSec = Math.max(0, Math.floor(now / 1000) - reading.publishTime);
    if (stalenessSec >= this.config.pythStalenessSec) {
      const ev = this.emit({
        kind: 'pyth-stale',
        severity: 'warning',
        market: marketLabel,
        mint: side.mint,
        message: `Pyth feed for ${this.shortMint(side.mint)} is stale: ${stalenessSec}s since publish (price $${reading.price.toFixed(4)})`,
        data: { stalenessSec, publishTime: reading.publishTime, pythPrice: reading.price },
        timestamp: now,
      });
      if (ev) events.push(ev);
    }

    if (reading.price > 0) {
      const confPct = (reading.confidence / reading.price) * 100;
      if (confPct >= this.config.pythConfidencePct) {
        const ev = this.emit({
          kind: 'pyth-confidence',
          severity: 'warning',
          market: marketLabel,
          mint: side.mint,
          message: `Pyth confidence wide for ${this.shortMint(side.mint)}: ±${confPct.toFixed(2)}% (price $${reading.price.toFixed(4)} ± $${reading.confidence.toFixed(4)})`,
          data: { confidencePct: confPct, pythPrice: reading.price, pythConfidence: reading.confidence },
          timestamp: now,
        });
        if (ev) events.push(ev);
      }
    }

    return events;
  }

  /**
   * USDC / USDT / etc.: oracle price diverges from $1.00 peg.
   * Critical depeg is a NAV-wide event — orchestrator should trip all protocols.
   */
  private checkStableDepeg(
    marketLabel: string,
    side: { mint: string; oracle: number; stored: number },
    now: number,
  ): OracleAnomalyEvent | null {
    if (!PEGGED_STABLECOINS.has(side.mint)) return null;
    if (!Number.isFinite(side.oracle) || side.oracle <= 0) return null;

    const deviationBps = Math.abs(side.oracle - 1.0) * 10_000;
    const sKey = this.sustainedKey('stable-depeg', '*', side.mint);
    if (deviationBps < this.config.usdcDeviationCriticalBps) {
      this.clearSustained(sKey);
    }

    if (deviationBps >= this.config.usdcDeviationCriticalBps) {
      return this.emit({
        kind: 'stable-depeg',
        severity: 'critical',
        market: '*',
        mint: side.mint,
        message: `Stablecoin depeg (critical): ${this.shortMint(side.mint)} oracle $${side.oracle.toFixed(4)} (${deviationBps.toFixed(0)}bps)`,
        data: { deviationBps, oraclePrice: side.oracle, sourceMarket: marketLabel },
        timestamp: now,
      });
    }

    if (deviationBps >= this.config.usdcDeviationWarnBps) {
      return this.emit({
        kind: 'stable-depeg',
        severity: 'warning',
        market: '*',
        mint: side.mint,
        message: `Stablecoin depeg (warning): ${this.shortMint(side.mint)} oracle $${side.oracle.toFixed(4)} (${deviationBps.toFixed(0)}bps)`,
        data: { deviationBps, oraclePrice: side.oracle, sourceMarket: marketLabel },
        timestamp: now,
      });
    }

    return null;
  }

  /**
   * Kamino's reserve state caches a price (`stored`) until the reserve is
   * refreshed; liquidation math runs against that stored price. If the
   * underlying oracle has moved significantly since the last refresh, our
   * health-rate readings are stale.
   *
   * Warning only — no protocol-level action; treat as observability for
   * operators and a hint that something is delaying refreshes.
   */
  private checkKaminoStale(
    marketLabel: string,
    side: { mint: string; oracle: number; stored: number },
    now: number,
  ): OracleAnomalyEvent | null {
    if (!Number.isFinite(side.oracle) || !Number.isFinite(side.stored)) return null;
    if (side.oracle <= 0 || side.stored <= 0) return null;

    const deltaBps = Math.abs(side.oracle - side.stored) / side.stored * 10_000;
    if (deltaBps < this.config.kaminoStaleStoredBps) return null;

    return this.emit({
      kind: 'kamino-stale',
      severity: 'warning',
      market: marketLabel,
      mint: side.mint,
      message: `Kamino stored-vs-oracle delta ${deltaBps.toFixed(0)}bps on ${this.shortMint(side.mint)} (stored $${side.stored.toFixed(4)} vs oracle $${side.oracle.toFixed(4)})`,
      data: {
        deltaBps,
        storedPrice: side.stored,
        oraclePrice: side.oracle,
      },
      timestamp: now,
    });
  }

  /**
   * Apply sustained-N gate (critical only) and per-(kind, market, mint, severity)
   * cooldown so alerts don't spam.
   *
   * For critical events: increments a per-key consecutive sample count and
   * sets `event.sustained = (count >= sustainedSamples)`. Pre-sustained
   * critical events are still returned (so the orchestrator can log them as
   * "watching"), but the orchestrator should only trip / deleverage when
   * `sustained === true`. Cooldown applies once the sustained threshold is
   * crossed.
   *
   * For warning events: emit on first sample, then suppress within cooldown.
   */
  private emit(event: OracleAnomalyEvent): OracleAnomalyEvent | null {
    const sKey = this.sustainedKey(event.kind, event.market, event.mint);

    if (event.severity === 'critical') {
      const next = (this.criticalSampleCounts.get(sKey) ?? 0) + 1;
      this.criticalSampleCounts.set(sKey, next);
      event.consecutiveCount = next;
      event.sustained = next >= this.config.sustainedSamples;
    }

    // Cooldown only applies to user-facing alerts: warnings every cycle are
    // noise; sustained criticals every cycle once tripped are noise too.
    // Pre-sustained critical events bypass cooldown so the orchestrator and
    // logs see every sample.
    const alertKey = `${sKey}:${event.severity}:${event.sustained ? 'sustained' : 'pre'}`;
    const isAlertable = event.severity === 'warning' || event.sustained === true;
    if (isAlertable) {
      const last = this.lastAlerts.get(alertKey) ?? 0;
      if (event.timestamp - last < this.config.alertCooldownMs) {
        // Within cooldown — still return the event for orchestrator routing,
        // but skip the user-facing notification.
        log.debug({ kind: event.kind, market: event.market }, 'oracle event within cooldown, suppressing alert');
        return event;
      }
      this.lastAlerts.set(alertKey, event.timestamp);
    }

    const logFn = event.severity === 'critical' ? 'error' : 'warn';
    log[logFn](
      {
        kind: event.kind,
        market: event.market,
        mint: event.mint,
        sustained: event.sustained,
        consecutiveCount: event.consecutiveCount,
        ...event.data,
      },
      event.message,
    );

    if (isAlertable) {
      void sendAlert(event.message, event.severity);
    }

    return event;
  }

  private shortMint(mint: string): string {
    return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
  }

  /** Expose current config (read-only) for diagnostics. */
  getConfig(): OracleMonitorConfig {
    return { ...this.config };
  }
}
