import { createChildLogger } from '../utils/logger.js';
import { KaminoMultiplyLending, type KaminoMultiplyConfig } from '../connectors/defi/kamino-multiply.js';
import { getPrimeApy, PRIME_MINT } from '../connectors/defi/hastra-apy.js';
import { MultiplyRiskScorer } from '../risk/multiply-risk-scorer.js';
import type { MultiplyCandidate, MultiplyRebalanceConfig, CapacityInfo, RiskAssessment } from '../types.js';
import type Database from 'better-sqlite3';

const log = createChildLogger('market-scanner');

export interface ScanResult {
  label: string;
  effectiveApy: number;
  /** Risk-adjusted APY (effectiveApy - riskPenalty) */
  adjustedApy: number;
  /** @deprecated Use riskAssessment.compositeScore instead */
  riskTier: number;
  candidate: MultiplyCandidate;
  scannedAt: number;
  /** Deposit capacity info (null if fetch failed) */
  capacity: CapacityInfo | null;
  /** Dynamic risk assessment (null if scorer unavailable) */
  riskAssessment: RiskAssessment | null;
}

export interface SwitchRecommendation {
  from: string;
  to: string;
  fromApy: number;
  toApy: number;
  diffBps: number;
  candidate: MultiplyCandidate;
}

interface ApyRecord {
  label: string;
  effectiveApy: number;
  adjustedApy: number;
  timestamp: number;
}

/**
 * Scans Kamino Multiply candidate markets for APY comparison.
 * Creates read-only KaminoMultiplyLending adapters (no secretKey) to query on-chain APY.
 * Maintains a 24h moving average to avoid chasing transient spikes.
 */
export class MarketScanner {
  private candidates: MultiplyCandidate[];
  private config: MultiplyRebalanceConfig;
  private rpcUrl: string;
  private walletAddress: string;
  private secretKey: Uint8Array;

  /** In-memory APY history for moving average */
  private apyHistory: Map<string, ApyRecord[]> = new Map();

  /** Latest capacity per candidate (updated on each scan) */
  private latestCapacity: Map<string, CapacityInfo> = new Map();

  /** Timestamp of last market switch */
  private lastSwitchAt: number = 0;

  private db: Database.Database;
  private insertStmt: Database.Statement | null = null;

  /** Risk scorer for dynamic risk assessment (null = use legacy riskTier) */
  private riskScorer: MultiplyRiskScorer | null = null;

  /** Latest risk assessments per label */
  private latestRiskAssessments: Map<string, RiskAssessment> = new Map();

  /** Max position cap from config for risk scoring */
  private maxPositionCapUsd: number;

  constructor(
    candidates: MultiplyCandidate[],
    config: MultiplyRebalanceConfig,
    rpcUrl: string,
    walletAddress: string,
    secretKey: Uint8Array,
    db: Database.Database,
    riskScorer?: MultiplyRiskScorer | null,
    maxPositionCapUsd?: number,
  ) {
    this.candidates = candidates;
    this.config = config;
    this.rpcUrl = rpcUrl;
    this.walletAddress = walletAddress;
    this.secretKey = secretKey;
    this.db = db;
    this.riskScorer = riskScorer ?? null;
    this.maxPositionCapUsd = maxPositionCapUsd ?? 10_000;
    this.initDb();
    this.loadHistory();

    log.info(
      { candidateCount: candidates.length, labels: candidates.map((c) => c.label) },
      'MarketScanner initialized',
    );
  }

  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS multiply_apy_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        effective_apy REAL NOT NULL,
        adjusted_apy REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_multiply_apy_label_ts
        ON multiply_apy_history(label, timestamp);
    `);
    this.insertStmt = this.db.prepare(
      'INSERT INTO multiply_apy_history (label, effective_apy, adjusted_apy, timestamp) VALUES (?, ?, ?, ?)',
    );
  }

  /** Load recent 24h history from DB on startup */
  private loadHistory(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare('SELECT label, effective_apy, adjusted_apy, timestamp FROM multiply_apy_history WHERE timestamp > ?')
      .all(cutoff) as { label: string; effective_apy: number; adjusted_apy: number; timestamp: number }[];

    for (const row of rows) {
      const records = this.apyHistory.get(row.label) ?? [];
      records.push({
        label: row.label,
        effectiveApy: row.effective_apy,
        adjustedApy: row.adjusted_apy,
        timestamp: row.timestamp,
      });
      this.apyHistory.set(row.label, records);
    }

    log.info({ recordCount: rows.length }, 'Loaded APY history from DB');
  }

  /** Prune history older than 24h */
  private pruneHistory(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [label, records] of this.apyHistory) {
      const pruned = records.filter((r) => r.timestamp > cutoff);
      if (pruned.length === 0) {
        this.apyHistory.delete(label);
      } else {
        this.apyHistory.set(label, pruned);
      }
    }
    // DB cleanup (keep 7 days for analysis)
    const dbCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    this.db.prepare('DELETE FROM multiply_apy_history WHERE timestamp < ?').run(dbCutoff);
  }

  /**
   * Create a read-only adapter for APY scanning.
   */
  private createReadOnlyAdapter(candidate: MultiplyCandidate): KaminoMultiplyLending {
    const cfg: KaminoMultiplyConfig = {
      market: candidate.market,
      collToken: candidate.collToken,
      debtToken: candidate.debtToken,
      label: candidate.label,
      targetHealthRate: candidate.targetHealthRate ?? this.config.defaultTargetHealthRate,
      alertHealthRate: candidate.alertHealthRate ?? this.config.defaultAlertHealthRate,
      emergencyHealthRate: candidate.emergencyHealthRate ?? this.config.defaultEmergencyHealthRate,
      collDecimals: candidate.collDecimals ?? 6,
      debtDecimals: candidate.debtDecimals ?? 6,
      collNativeYield: candidate.collNativeYield ?? 0,
      claimRewards: false,
      inputToken: candidate.inputToken,
      inputDecimals: candidate.inputDecimals,
    };
    // Pass rpcUrl but no secretKey — read-only mode
    return new KaminoMultiplyLending(this.walletAddress, cfg, this.rpcUrl);
  }

  /**
   * Create a full adapter with signing capability for switching.
   */
  createFullAdapter(candidate: MultiplyCandidate): KaminoMultiplyLending {
    const cfg: KaminoMultiplyConfig = {
      market: candidate.market,
      collToken: candidate.collToken,
      debtToken: candidate.debtToken,
      label: candidate.label,
      targetHealthRate: candidate.targetHealthRate ?? this.config.defaultTargetHealthRate,
      alertHealthRate: candidate.alertHealthRate ?? this.config.defaultAlertHealthRate,
      emergencyHealthRate: candidate.emergencyHealthRate ?? this.config.defaultEmergencyHealthRate,
      collDecimals: candidate.collDecimals ?? 6,
      debtDecimals: candidate.debtDecimals ?? 6,
      collNativeYield: candidate.collNativeYield ?? 0,
      claimRewards: candidate.claimRewards ?? true,
      inputToken: candidate.inputToken,
      inputDecimals: candidate.inputDecimals,
    };
    return new KaminoMultiplyLending(this.walletAddress, cfg, this.rpcUrl, this.secretKey);
  }

  /**
   * Fetch live native yield for dynamic-yield tokens (e.g. PRIME from Hastra).
   * Updates candidate collNativeYield in-place before APY scan.
   *
   * Note: ONyc yield is fetched inside KaminoMultiplyLending.getApy() directly
   * via on-chain PDA read, so no pre-fetch needed here.
   */
  private async fetchDynamicNativeYields(): Promise<void> {
    const primeCandidates = this.candidates.filter((c) => c.collToken === PRIME_MINT);
    if (primeCandidates.length === 0) return;

    try {
      const result = await getPrimeApy(primeCandidates[0]!.collNativeYield ?? 0.08);
      for (const c of primeCandidates) {
        c.collNativeYield = result.apy;
      }
      log.info(
        { primeNativeYield: `${(result.apy * 100).toFixed(2)}%`, source: result.source },
        'PRIME native yield updated for scanner',
      );
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to fetch PRIME native yield, using config default');
    }
  }

  /**
   * Scan all candidates and return current APY data.
   */
  async scanAll(): Promise<ScanResult[]> {
    // Refresh dynamic native yields before scanning
    await this.fetchDynamicNativeYields();

    const results: ScanResult[] = [];
    const now = Date.now();

    const scanPromises = this.candidates.map(async (candidate) => {
      try {
        const adapter = this.createReadOnlyAdapter(candidate);
        const [effectiveApy, capacity] = await Promise.all([
          adapter.getApy(),
          adapter.getCapacity().catch((err) => {
            log.warn({ label: candidate.label, error: (err as Error).message }, 'Failed to fetch capacity');
            return null;
          }),
        ]);
        // Dynamic risk assessment (fallback to legacy riskTier/riskPenalty)
        let riskAssessment: RiskAssessment | null = null;
        let riskPenalty: number;
        if (this.riskScorer) {
          riskAssessment = await this.riskScorer.assessCandidate(candidate, this.maxPositionCapUsd);
          riskPenalty = riskAssessment.riskPenalty;
          this.latestRiskAssessments.set(candidate.label, riskAssessment);
        } else {
          riskPenalty = (this.config.riskPenalty ?? [0, 0.005, 0.015])[(candidate.riskTier ?? 2) - 1] ?? 0;
        }
        const adjustedApy = effectiveApy - riskPenalty;

        const result: ScanResult = {
          label: candidate.label,
          effectiveApy,
          adjustedApy,
          riskTier: candidate.riskTier ?? 2,
          candidate,
          scannedAt: now,
          capacity,
          riskAssessment,
        };

        // Store in history
        const records = this.apyHistory.get(candidate.label) ?? [];
        records.push({ label: candidate.label, effectiveApy, adjustedApy, timestamp: now });
        this.apyHistory.set(candidate.label, records);

        // Persist to DB
        this.insertStmt?.run(candidate.label, effectiveApy, adjustedApy, now);

        return result;
      } catch (err) {
        log.warn(
          { label: candidate.label, error: (err as Error).message },
          'Failed to scan candidate',
        );
        return null;
      }
    });

    const settled = await Promise.allSettled(scanPromises);
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) {
        results.push(s.value);
        if (s.value.capacity) {
          this.latestCapacity.set(s.value.label, s.value.capacity);
        }
      }
    }

    this.pruneHistory();

    log.info(
      {
        scanned: results.length,
        results: results.map((r) => ({
          label: r.label,
          apy: `${(r.effectiveApy * 100).toFixed(2)}%`,
          adjusted: `${(r.adjustedApy * 100).toFixed(2)}%`,
          remainingCapacity: r.capacity ? `${r.capacity.remaining.toFixed(0)}` : 'N/A',
          utilization: r.capacity ? `${(r.capacity.utilizationRatio * 100).toFixed(1)}%` : 'N/A',
        })),
      },
      'Market scan complete',
    );

    return results;
  }

  /**
   * Get 24h moving average adjusted APY for a candidate.
   */
  getMovingAvgApy(label: string): number | null {
    const records = this.apyHistory.get(label);
    if (!records || records.length === 0) return null;

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = records.filter((r) => r.timestamp > cutoff);
    if (recent.length === 0) return null;

    return recent.reduce((sum, r) => sum + r.adjustedApy, 0) / recent.length;
  }

  /**
   * Evaluate whether a market switch is recommended.
   * @param currentLabel — label of the currently active strategy
   * @param deployableAmount — amount (in token units) we plan to deposit; candidates with
   *   insufficient remaining capacity are excluded.
   * Returns null if no switch is warranted.
   */
  getRecommendation(currentLabel: string, deployableAmount?: number): SwitchRecommendation | null {
    // Check min holding period
    const daysSinceSwitch = (Date.now() - this.lastSwitchAt) / (1000 * 60 * 60 * 24);
    if (this.lastSwitchAt > 0 && daysSinceSwitch < this.config.minHoldingDays) {
      log.debug(
        { daysSinceSwitch: daysSinceSwitch.toFixed(1), minDays: this.config.minHoldingDays },
        'Min holding period not met, skipping switch evaluation',
      );
      return null;
    }

    const currentAvg = this.getMovingAvgApy(currentLabel);
    if (currentAvg === null) {
      log.debug({ currentLabel }, 'No APY data for current market');
      return null;
    }

    let bestLabel = currentLabel;
    let bestAvg = currentAvg;

    for (const candidate of this.candidates) {
      if (candidate.label === currentLabel) continue;

      // Skip candidates with risk score above reject threshold
      const ra = this.latestRiskAssessments.get(candidate.label);
      if (ra && ra.compositeScore >= (this.riskScorer ? 90 : Infinity)) {
        log.debug({ label: candidate.label, score: ra.compositeScore.toFixed(1) }, 'Skipping candidate — risk score above reject threshold');
        continue;
      }

      // Skip candidates with insufficient deposit capacity
      if (deployableAmount !== undefined) {
        const cap = this.latestCapacity.get(candidate.label);
        if (cap && cap.remaining < deployableAmount) {
          log.debug(
            { label: candidate.label, remaining: cap.remaining.toFixed(0), needed: deployableAmount.toFixed(0) },
            'Skipping candidate — insufficient deposit capacity',
          );
          continue;
        }
      }

      const avg = this.getMovingAvgApy(candidate.label);
      if (avg !== null && avg > bestAvg) {
        bestAvg = avg;
        bestLabel = candidate.label;
      }
    }

    if (bestLabel === currentLabel) return null;

    const diffBps = Math.round((bestAvg - currentAvg) * 10_000);

    if (diffBps < this.config.minDiffBps) {
      log.debug(
        { current: currentLabel, best: bestLabel, diffBps, minDiffBps: this.config.minDiffBps },
        'APY diff below threshold',
      );
      return null;
    }

    const bestCandidate = this.candidates.find((c) => c.label === bestLabel)!;

    log.info(
      {
        from: currentLabel,
        to: bestLabel,
        fromApy: `${(currentAvg * 100).toFixed(2)}%`,
        toApy: `${(bestAvg * 100).toFixed(2)}%`,
        diffBps,
      },
      'Market switch recommended',
    );

    return {
      from: currentLabel,
      to: bestLabel,
      fromApy: currentAvg,
      toApy: bestAvg,
      diffBps,
      candidate: bestCandidate,
    };
  }

  /** Record that a switch happened (resets holding period timer) */
  recordSwitch(): void {
    this.lastSwitchAt = Date.now();
  }

  /** Get all latest scan results for API/monitoring */
  getLatestScans(): { label: string; effectiveApy: number; adjustedApy: number; movingAvg: number | null; capacity: CapacityInfo | null; riskAssessment: RiskAssessment | null }[] {
    return this.candidates.map((c) => {
      const records = this.apyHistory.get(c.label);
      const latest = records?.[records.length - 1];
      return {
        label: c.label,
        effectiveApy: latest?.effectiveApy ?? 0,
        adjustedApy: latest?.adjustedApy ?? 0,
        movingAvg: this.getMovingAvgApy(c.label),
        capacity: this.latestCapacity.get(c.label) ?? null,
        riskAssessment: this.latestRiskAssessments.get(c.label) ?? null,
      };
    });
  }

  /** Get latest risk assessments */
  getRiskAssessments(): Map<string, RiskAssessment> {
    return this.latestRiskAssessments;
  }
}
