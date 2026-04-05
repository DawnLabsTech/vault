import type Database from 'better-sqlite3';
import type { FrMonitor } from '../core/fr-monitor.js';
import type { BaseAllocator } from '../strategies/base-allocator.js';
import type { KaminoMultiplyLending } from '../connectors/defi/kamino-multiply.js';
import type { MarketScanner } from '../core/market-scanner.js';
import type { VaultConfig, BotState } from '../types.js';
import { getLatestSnapshot } from '../measurement/snapshots.js';
import { getEvents } from '../measurement/events.js';
import { getPrices } from '../connectors/prices.js';
import type { AdvisorContext } from './types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('advisor-context');

export interface ContextBuilderDeps {
  frMonitor: FrMonitor;
  baseAllocator: BaseAllocator;
  kaminoMultiplyAdapters?: KaminoMultiplyLending[];
  marketScanner?: MarketScanner | null;
  db: Database.Database;
}

/**
 * Build a structured context object from the bot's current state.
 * This is fed to the LLM as part of the advisor prompt.
 */
export async function buildAdvisorContext(
  deps: ContextBuilderDeps,
  botState: BotState,
  config: VaultConfig,
): Promise<AdvisorContext> {
  const thresholds = config.thresholds;

  // Fetch data in parallel where possible
  const [
    snapshot,
    lendingAllocations,
    lendingApyRanking,
    prices,
  ] = await Promise.all([
    getLatestSnapshot(),
    deps.baseAllocator.getCurrentAllocations(),
    deps.baseAllocator.getApyRanking(),
    getPrices(),
  ]);

  // FR data (synchronous from SQLite)
  const latestFrAnnualized = deps.frMonitor.getLatestAnnualized();
  const avgFr3d = deps.frMonitor.getAverageAnnualized(3);
  const avgFr7d = deps.frMonitor.getAverageAnnualized(7);
  const daysAboveEntry = deps.frMonitor.getDaysAboveThreshold(thresholds.frEntryAnnualized);
  const daysBelowExit = deps.frMonitor.getDaysBelowThreshold(thresholds.frExitAnnualized);

  // FR history (last 24h = ~3 records)
  const frHistory = deps.frMonitor.getFrHistory(9); // 3 days of data
  const frHistory24h = frHistory.slice(0, 3).map((fr) => ({
    time: new Date(fr.fundingTime).toISOString(),
    annualized: Math.round(fr.fundingRate * 3 * 365 * 10000) / 100, // rough annualized %
  }));

  // Lending APYs
  const lendingApys: Record<string, number> = {};
  for (const item of lendingApyRanking) {
    lendingApys[item.protocol] = Math.round(item.apy * 10000) / 100; // as percentage
  }

  // Multiply APYs and health rates
  const multiplyApys: Record<string, number> = {};
  const multiplyHealthRates: Record<string, number> = {};
  const riskAssessments: AdvisorContext['riskAssessments'] = [];

  if (deps.kaminoMultiplyAdapters) {
    for (const adapter of deps.kaminoMultiplyAdapters) {
      try {
        const apy = await adapter.getApy();
        multiplyApys[adapter.name] = Math.round(apy * 10000) / 100;
      } catch {
        log.warn({ adapter: adapter.name }, 'Failed to get Multiply APY');
      }
      try {
        const health = await adapter.getHealthRate();
        if (health !== null) {
          multiplyHealthRates[adapter.name] = Math.round(health * 1000) / 1000;
        }
      } catch {
        log.warn({ adapter: adapter.name }, 'Failed to get Multiply health rate');
      }
    }
  }

  // Risk assessments from market scanner
  if (deps.marketScanner) {
    try {
      const scanResults = deps.marketScanner.getLatestScans();
      for (const result of scanResults) {
        if (result.riskAssessment) {
          riskAssessments.push({
            label: result.label,
            compositeScore: result.riskAssessment.compositeScore,
            dimensions: result.riskAssessment.dimensions as unknown as Record<string, number>,
            alertLevel: result.riskAssessment.alertLevel,
          });
        }
      }
    } catch {
      log.warn('Failed to get risk assessments from market scanner');
    }
  }

  // Lending breakdown
  const lendingBreakdown: Record<string, number> = {};
  for (const [name, balance] of lendingAllocations) {
    lendingBreakdown[name] = Math.round(balance * 100) / 100;
  }

  // Recent events (last 24h, max 20)
  const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const rawEvents = getEvents({ from: oneDayAgo, limit: 20 });
  const recentEvents = rawEvents.map((e) => ({
    timestamp: e.timestamp,
    type: e.eventType,
    amount: e.amount,
    asset: e.asset,
    protocol: e.sourceProtocol,
  }));

  // Daily PnL (latest)
  let dailyPnl: AdvisorContext['dailyPnl'] = null;
  try {
    const row = deps.db
      .prepare('SELECT * FROM daily_pnl ORDER BY date DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    if (row) {
      dailyPnl = {
        dailyReturn: row['daily_return'] as number,
        cumulativeReturn: row['cumulative_return'] as number,
        maxDrawdown: row['max_drawdown'] as number,
      };
    }
  } catch {
    log.warn('Failed to get daily PnL');
  }

  return {
    botState,
    totalNavUsdc: snapshot?.totalNavUsdc ?? 0,
    lendingBalance: snapshot?.lendingBalance ?? 0,
    lendingBreakdown,
    multiplyBalance: snapshot?.multiplyBalance ?? 0,
    multiplyBreakdown: snapshot?.multiplyBreakdown ?? {},
    bufferUsdcBalance: snapshot?.bufferUsdcBalance ?? 0,

    latestFrAnnualized,
    avgFr3d,
    avgFr7d,
    daysAboveEntry,
    daysBelowExit,
    frHistory24h,

    lendingApys,
    multiplyApys,

    riskAssessments,
    multiplyHealthRates,

    recentEvents,
    dailyPnl,

    solPrice: prices.sol,

    thresholds: {
      frEntryAnnualized: thresholds.frEntryAnnualized,
      frEntryConfirmationDays: thresholds.frEntryConfirmationDays,
      frExitAnnualized: thresholds.frExitAnnualized,
      frExitConfirmationDays: thresholds.frExitConfirmationDays,
      frEmergencyAnnualized: thresholds.frEmergencyAnnualized,
      lendingRebalanceMinDiffBps: thresholds.lendingRebalanceMinDiffBps,
      dailyLossLimitPct: config.risk.dailyLossLimitPct,
      maxPositionCapUsd: config.risk.maxPositionCapUsd,
    },
  };
}

/**
 * Convert the context object to a concise text block for the LLM prompt.
 */
export function contextToPromptText(ctx: AdvisorContext): string {
  const lines: string[] = [];

  lines.push('## Current State');
  lines.push(`Bot State: ${ctx.botState}`);
  lines.push(`NAV: $${ctx.totalNavUsdc.toFixed(2)}`);
  lines.push(`SOL Price: $${ctx.solPrice.toFixed(2)}`);

  lines.push('\n## Positions');
  lines.push(`Multiply: $${ctx.multiplyBalance.toFixed(2)}`);
  if (Object.keys(ctx.multiplyBreakdown).length > 0) {
    for (const [label, val] of Object.entries(ctx.multiplyBreakdown)) {
      lines.push(`  - ${label}: $${val.toFixed(2)}`);
    }
  }
  lines.push(`Lending: $${ctx.lendingBalance.toFixed(2)}`);
  for (const [proto, bal] of Object.entries(ctx.lendingBreakdown)) {
    lines.push(`  - ${proto}: $${bal.toFixed(2)}`);
  }
  lines.push(`Buffer: $${ctx.bufferUsdcBalance.toFixed(2)}`);

  lines.push('\n## Funding Rate');
  lines.push(`Latest (annualized): ${ctx.latestFrAnnualized.toFixed(2)}%`);
  lines.push(`3d avg: ${ctx.avgFr3d.toFixed(2)}% | 7d avg: ${ctx.avgFr7d.toFixed(2)}%`);
  lines.push(`Days above entry (${ctx.thresholds.frEntryAnnualized}%): ${ctx.daysAboveEntry}`);
  lines.push(`Days below exit (${ctx.thresholds.frExitAnnualized}%): ${ctx.daysBelowExit}`);
  if (ctx.frHistory24h.length > 0) {
    lines.push('Recent FR:');
    for (const fr of ctx.frHistory24h) {
      lines.push(`  - ${fr.time}: ${fr.annualized.toFixed(2)}%`);
    }
  }

  lines.push('\n## APY');
  lines.push('Lending:');
  for (const [proto, apy] of Object.entries(ctx.lendingApys)) {
    lines.push(`  - ${proto}: ${apy.toFixed(2)}%`);
  }
  if (Object.keys(ctx.multiplyApys).length > 0) {
    lines.push('Multiply:');
    for (const [label, apy] of Object.entries(ctx.multiplyApys)) {
      lines.push(`  - ${label}: ${apy.toFixed(2)}%`);
    }
  }

  if (ctx.riskAssessments.length > 0) {
    lines.push('\n## Risk');
    for (const ra of ctx.riskAssessments) {
      lines.push(`${ra.label}: score=${ra.compositeScore}, level=${ra.alertLevel}`);
      const dims = ra.dimensions;
      lines.push(`  depeg=${dims['depegRisk']}, liq=${dims['liquidationProximity']}, exit=${dims['exitLiquidity']}, reserve=${dims['reservePressure']}`);
    }
  }

  if (Object.keys(ctx.multiplyHealthRates).length > 0) {
    lines.push('\n## Health Rates');
    for (const [label, hr] of Object.entries(ctx.multiplyHealthRates)) {
      lines.push(`  ${label}: ${hr.toFixed(3)}`);
    }
  }

  if (ctx.dailyPnl) {
    lines.push('\n## PnL');
    lines.push(`Daily return: ${(ctx.dailyPnl.dailyReturn * 100).toFixed(2)}%`);
    lines.push(`Cumulative: ${(ctx.dailyPnl.cumulativeReturn * 100).toFixed(2)}%`);
    lines.push(`Max drawdown: ${(ctx.dailyPnl.maxDrawdown * 100).toFixed(2)}%`);
  }

  if (ctx.recentEvents.length > 0) {
    lines.push('\n## Recent Events (24h)');
    for (const e of ctx.recentEvents.slice(0, 10)) {
      lines.push(`  ${e.timestamp} ${e.type} ${e.amount} ${e.asset}${e.protocol ? ` (${e.protocol})` : ''}`);
    }
  }

  lines.push('\n## Active Thresholds');
  lines.push(`FR entry: ${ctx.thresholds.frEntryAnnualized}% for ${ctx.thresholds.frEntryConfirmationDays}d`);
  lines.push(`FR exit: ${ctx.thresholds.frExitAnnualized}% for ${ctx.thresholds.frExitConfirmationDays}d`);
  lines.push(`FR emergency: ${ctx.thresholds.frEmergencyAnnualized}%`);
  lines.push(`Lending rebalance min diff: ${ctx.thresholds.lendingRebalanceMinDiffBps}bps`);
  lines.push(`Daily loss limit: ${ctx.thresholds.dailyLossLimitPct}%`);
  lines.push(`Max position cap: $${ctx.thresholds.maxPositionCapUsd}`);

  return lines.join('\n');
}
