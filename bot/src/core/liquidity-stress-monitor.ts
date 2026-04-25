import type Database from 'better-sqlite3';
import type { LiquidityStressConfig } from '../types.js';
import { createChildLogger } from '../utils/logger.js';
import { sendAlert } from '../utils/notify.js';

const log = createChildLogger('liquidity-stress');

const JUPITER_PRO_API_BASE = 'https://api.jup.ag';
const JUPITER_LITE_API_BASE = 'https://lite-api.jup.ag';
const JUPITER_QUOTE_API_PATH = '/swap/v1/quote';

/** Exit size tiers as fraction of total position */
const EXIT_TIERS = [0.25, 0.50, 1.0] as const;

const DEFAULT_CONFIG: LiquidityStressConfig = {
  warningSlippageBps: 100,
  criticalSlippageBps: 300,
  alertCooldownMs: 1_800_000,
  retentionDays: 7,
};

export interface ExitQuoteTier {
  /** Fraction of position (0.25, 0.50, 1.0) */
  tier: number;
  /** Exit size in USD */
  exitUsd: number;
  /** Price impact from Jupiter quote */
  priceImpactPct: number;
  /** Slippage in basis points */
  slippageBps: number;
}

export interface StressTestResult {
  label: string;
  positionUsd: number;
  tiers: ExitQuoteTier[];
  /** Highest slippage across all tiers */
  maxSlippageBps: number;
  /** Alert level triggered, or null */
  alertLevel: 'warning' | 'critical' | null;
  timestamp: number;
}

/**
 * Liquidity Stress Monitor
 *
 * Periodically fetches Jupiter exit quotes at multiple position sizes
 * (25%, 50%, 100%) to build a slippage curve.
 * Alerts via Telegram when slippage exceeds thresholds.
 * Stores history for trend analysis.
 */
export class LiquidityStressMonitor {
  private db: Database.Database;
  private config: LiquidityStressConfig;
  private insertStmt: Database.Statement;

  /** Cooldown tracking: label -> timestamp */
  private lastAlerts = new Map<string, { level: string; timestamp: number }>();

  constructor(db: Database.Database, config?: Partial<LiquidityStressConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initDb();

    this.insertStmt = db.prepare(`
      INSERT INTO liquidity_stress_history
        (timestamp, label, position_usd, tier, exit_usd, price_impact_pct, slippage_bps)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  // ── DB Setup ────────────────────────────────────────────

  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS liquidity_stress_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        label TEXT NOT NULL,
        position_usd REAL NOT NULL,
        tier REAL NOT NULL,
        exit_usd REAL NOT NULL,
        price_impact_pct REAL NOT NULL,
        slippage_bps REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_liq_stress_label_ts
        ON liquidity_stress_history(label, timestamp);
    `);

    // Prune old records
    const cutoff = new Date(Date.now() - this.config.retentionDays * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM liquidity_stress_history WHERE timestamp < ?').run(cutoff);
  }

  // ── Core ────────────────────────────────────────────────

  /**
   * Run stress test for a single Multiply position.
   * Fetches exit quotes at 25%, 50%, 100% of positionUsd.
   */
  async runStressTest(params: {
    label: string;
    collToken: string;
    debtToken: string;
    collDecimals: number;
    positionUsd: number;
  }): Promise<StressTestResult> {
    const { label, collToken, debtToken, collDecimals, positionUsd } = params;
    const now = Date.now();
    const ts = new Date(now).toISOString();

    if (positionUsd < 1) {
      return { label, positionUsd, tiers: [], maxSlippageBps: 0, alertLevel: null, timestamp: now };
    }

    const tiers: ExitQuoteTier[] = [];

    for (const tierFrac of EXIT_TIERS) {
      const exitUsd = positionUsd * tierFrac;
      const amount = Math.floor(exitUsd * 10 ** collDecimals);

      try {
        const quote = await this.fetchJupiterQuote(collToken, debtToken, amount);
        const priceImpactPct = parseFloat(quote.priceImpactPct ?? '0');
        const slippageBps = Math.abs(priceImpactPct) * 100;

        tiers.push({ tier: tierFrac, exitUsd, priceImpactPct, slippageBps });

        this.insertStmt.run(ts, label, positionUsd, tierFrac, exitUsd, priceImpactPct, slippageBps);
      } catch (err) {
        log.warn(
          { label, tier: tierFrac, exitUsd, error: (err as Error).message },
          'Failed to fetch exit quote for tier',
        );
        // Record failure as high slippage to be safe
        tiers.push({ tier: tierFrac, exitUsd, priceImpactPct: 0, slippageBps: -1 });
      }
    }

    const validTiers = tiers.filter((t) => t.slippageBps >= 0);
    const maxSlippageBps = validTiers.length > 0
      ? Math.max(...validTiers.map((t) => t.slippageBps))
      : 0;

    // Determine alert level
    let alertLevel: StressTestResult['alertLevel'] = null;
    if (maxSlippageBps >= this.config.criticalSlippageBps) {
      alertLevel = 'critical';
    } else if (maxSlippageBps >= this.config.warningSlippageBps) {
      alertLevel = 'warning';
    }

    const result: StressTestResult = { label, positionUsd, tiers, maxSlippageBps, alertLevel, timestamp: now };

    log.info(
      {
        label,
        positionUsd: positionUsd.toFixed(0),
        tiers: tiers.map((t) => `${(t.tier * 100).toFixed(0)}%=${t.slippageBps.toFixed(1)}bps`).join(', '),
        maxSlippageBps: maxSlippageBps.toFixed(1),
        alertLevel,
      },
      'Liquidity stress test complete',
    );

    // Send alert if threshold exceeded and not in cooldown
    if (alertLevel) {
      await this.sendStressAlert(result);
    }

    return result;
  }

  // ── Queries ─────────────────────────────────────────────

  /** Get latest stress test result for a label */
  getLatest(label: string): StressTestResult | null {
    const rows = this.db
      .prepare(`
        SELECT timestamp, position_usd, tier, exit_usd, price_impact_pct, slippage_bps
        FROM liquidity_stress_history
        WHERE label = ? AND timestamp = (
          SELECT MAX(timestamp) FROM liquidity_stress_history WHERE label = ?
        )
        ORDER BY tier ASC
      `)
      .all(label, label) as Array<{
        timestamp: string;
        position_usd: number;
        tier: number;
        exit_usd: number;
        price_impact_pct: number;
        slippage_bps: number;
      }>;

    if (rows.length === 0) return null;

    const tiers: ExitQuoteTier[] = rows.map((r) => ({
      tier: r.tier,
      exitUsd: r.exit_usd,
      priceImpactPct: r.price_impact_pct,
      slippageBps: r.slippage_bps,
    }));

    const maxSlippageBps = Math.max(...tiers.map((t) => t.slippageBps));
    let alertLevel: StressTestResult['alertLevel'] = null;
    if (maxSlippageBps >= this.config.criticalSlippageBps) alertLevel = 'critical';
    else if (maxSlippageBps >= this.config.warningSlippageBps) alertLevel = 'warning';

    return {
      label,
      positionUsd: rows[0]!.position_usd,
      tiers,
      maxSlippageBps,
      alertLevel,
      timestamp: new Date(rows[0]!.timestamp).getTime(),
    };
  }

  /** Get slippage trend for the 100% exit tier over the last N hours */
  getFullExitTrend(label: string, hours: number = 24): Array<{ timestamp: number; slippageBps: number }> {
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    const rows = this.db
      .prepare(`
        SELECT timestamp, slippage_bps
        FROM liquidity_stress_history
        WHERE label = ? AND tier = 1.0 AND timestamp > ?
        ORDER BY timestamp ASC
      `)
      .all(label, cutoff) as Array<{ timestamp: string; slippage_bps: number }>;

    return rows.map((r) => ({
      timestamp: new Date(r.timestamp).getTime(),
      slippageBps: r.slippage_bps,
    }));
  }

  /** Prune old records */
  prune(retentionDays: number): void {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const result = this.db
      .prepare('DELETE FROM liquidity_stress_history WHERE timestamp < ?')
      .run(cutoff);
    if (result.changes > 0) {
      log.info({ deleted: result.changes, retentionDays }, 'Pruned old liquidity stress records');
    }
  }

  // ── Alert ───────────────────────────────────────────────

  private async sendStressAlert(result: StressTestResult): Promise<void> {
    if (!result.alertLevel) return;

    const key = `${result.label}:${result.alertLevel}`;
    const now = Date.now();
    const last = this.lastAlerts.get(key);

    if (last && now - last.timestamp < this.config.alertCooldownMs) {
      log.debug({ label: result.label, alertLevel: result.alertLevel }, 'Alert suppressed (cooldown)');
      return;
    }

    // Critical bypasses warning cooldown
    if (result.alertLevel === 'critical') {
      this.lastAlerts.set(key, { level: result.alertLevel, timestamp: now });
    } else {
      this.lastAlerts.set(key, { level: result.alertLevel, timestamp: now });
    }

    const tierLines = result.tiers
      .filter((t) => t.slippageBps >= 0)
      .map((t) => `  ${(t.tier * 100).toFixed(0)}% ($${t.exitUsd.toFixed(0)}) → ${t.slippageBps.toFixed(1)} bps`)
      .join('\n');

    const message = [
      `Liquidity Stress [${result.label}]`,
      `Position: $${result.positionUsd.toFixed(0)}`,
      `Max slippage: ${result.maxSlippageBps.toFixed(1)} bps`,
      `Exit curve:`,
      tierLines,
    ].join('\n');

    await sendAlert(message, result.alertLevel);
  }

  // ── Jupiter ─────────────────────────────────────────────

  private async fetchJupiterQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
  ): Promise<{ priceImpactPct?: string }> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: '300',
    });

    const baseUrls = this.getJupiterApiBaseCandidates();
    let lastError: Error | null = null;

    for (const baseUrl of baseUrls) {
      try {
        const headers = this.getJupiterHeaders(baseUrl);
        const response = await fetch(`${baseUrl}${JUPITER_QUOTE_API_PATH}?${params.toString()}`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          return await response.json() as { priceImpactPct?: string };
        }
        lastError = new Error(`Jupiter quote ${response.status} via ${baseUrl}`);
        if (response.status >= 400 && response.status < 500 && ![401, 403, 404].includes(response.status)) {
          break;
        }
      } catch (err) {
        lastError = err as Error;
      }
    }

    throw lastError ?? new Error('Jupiter quote request failed');
  }

  private getJupiterApiBaseCandidates(): string[] {
    const configured = process.env.JUPITER_API_BASE_URL?.trim();
    if (configured) return [configured.replace(/\/+$/, '')];
    return process.env.JUPITER_API_KEY
      ? [JUPITER_PRO_API_BASE, JUPITER_LITE_API_BASE]
      : [JUPITER_LITE_API_BASE, JUPITER_PRO_API_BASE];
  }

  private getJupiterHeaders(baseUrl: string): HeadersInit | undefined {
    const apiKey = process.env.JUPITER_API_KEY?.trim();
    if (!apiKey) return undefined;
    if (baseUrl.replace(/\/+$/, '') !== JUPITER_PRO_API_BASE) return undefined;
    return { 'x-api-key': apiKey };
  }
}
