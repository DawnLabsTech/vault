import { BotState, type VaultConfig } from '@bot/types.js';
import { evaluateState } from '@bot/core/state-machine.js';
import { calcSharpeRatio, calcMaxDrawdown } from '@bot/utils/math.js';
import type { FrTick, SolPriceTick, BacktestConfig, BacktestResult, DailySnapshot } from '../types.js';
import {
  createPortfolio,
  accrueLendingInterest,
  accrueFunding,
  accrueDawnsolYield,
  enterDn,
  exitDn,
  updateNav,
} from './portfolio.js';
import { buildFrSignals } from './signal-builder.js';

const HOURS_PER_YEAR = 8760;

/**
 * Run the backtest simulation.
 * Iterates over 8h ticks, applying funding/lending/staking yields,
 * evaluating state transitions via the bot's pure state machine.
 */
export function runSimulation(
  frTicks: FrTick[],
  priceTicks: SolPriceTick[],
  config: BacktestConfig,
): BacktestResult {
  const portfolio = createPortfolio(config.initialCapital);
  const dailySnapshots: DailySnapshot[] = [];
  const navSeries: number[] = [];
  const dailyReturns: number[] = [];

  // Build a map of fundingTime -> FrTick for quick lookup
  const frByTime = new Map<number, FrTick>();
  for (const fr of frTicks) {
    frByTime.set(fr.fundingTime, fr);
  }

  // Pre-sort FR ticks by time for binary search fallback
  const sortedFrTicks = [...frTicks].sort((a, b) => a.fundingTime - b.fundingTime);

  // Track FR history for signal building
  const frHistory: FrTick[] = [];

  // Build mock VaultConfig for evaluateState
  const vaultConfig = buildVaultConfig(config);

  let totalEntries = 0;
  let totalExits = 0;
  let daysInBaseOnly = 0;
  let daysInBaseDn = 0;
  let lastDate = '';
  let dayStartNav = config.initialCapital;
  const startSolPrice = priceTicks[0]?.close ?? 0;

  for (const priceTick of priceTicks) {
    const solPrice = priceTick.close;
    const tickDate = new Date(priceTick.openTime).toISOString().slice(0, 10);

    // Find matching FR tick
    const frTick = findClosestFr(frByTime, priceTick.openTime, sortedFrTicks);

    if (frTick) {
      frHistory.push(frTick);
    }

    // 1. Accrue yields
    accrueLendingInterest(portfolio, config.lendingApy);

    if (portfolio.state === BotState.BASE_DN) {
      if (frTick) {
        accrueFunding(portfolio, solPrice, frTick.fundingRate);
      }
      accrueDawnsolYield(portfolio, solPrice, config.dawnsolApy);
    }

    // 2. Build signals and evaluate state
    const signals = buildFrSignals(
      frHistory,
      config.frEntryAnnualized,
      config.frExitAnnualized,
    );

    const stateSignals = {
      currentState: portfolio.state,
      avgFrAnnualized: signals.avgFrAnnualized,
      latestFrAnnualized: signals.latestFrAnnualized,
      daysAboveEntry: signals.daysAboveEntry,
      daysBelowExit: signals.daysBelowExit,
      riskApproved: true,
      dnOperationInProgress: false,
      totalNavUsdc: portfolio.totalNavUsdc,
    };

    const result = evaluateState(stateSignals, vaultConfig);

    // 3. Execute state transitions
    if (result.nextState !== portfolio.state) {
      if (result.nextState === BotState.BASE_DN) {
        enterDn(portfolio, solPrice, config.dnAllocation);
        totalEntries++;
      } else {
        exitDn(portfolio, solPrice);
        totalExits++;
      }
    }

    // 4. Update NAV
    updateNav(portfolio, solPrice);
    navSeries.push(portfolio.totalNavUsdc);

    // 5. Daily snapshot (at day boundary)
    if (tickDate !== lastDate) {
      if (lastDate !== '') {
        const dailyReturn = dayStartNav > 0
          ? (portfolio.totalNavUsdc - dayStartNav) / dayStartNav
          : 0;
        dailyReturns.push(dailyReturn);

        const cumulativeReturn = (portfolio.totalNavUsdc - config.initialCapital) / config.initialCapital;

        dailySnapshots.push({
          date: tickDate,
          nav: portfolio.totalNavUsdc,
          dailyReturn,
          cumulativeReturn,
          state: portfolio.state,
          solPrice,
          fundingRate8h: frTick?.fundingRate ?? 0,
        });

        if (portfolio.state === BotState.BASE_ONLY) daysInBaseOnly++;
        else daysInBaseDn++;
      }
      dayStartNav = portfolio.totalNavUsdc;
      lastDate = tickDate;
    }
  }

  // Calculate metrics
  const totalReturn = (portfolio.totalNavUsdc - config.initialCapital) / config.initialCapital;
  const totalDays = dailySnapshots.length;
  const annualizedReturn = totalDays > 0
    ? Math.pow(1 + totalReturn, 365 / totalDays) - 1
    : 0;

  // Benchmarks
  const endSolPrice = priceTicks[priceTicks.length - 1]?.close ?? startSolPrice;
  const solBuyAndHoldReturn = startSolPrice > 0
    ? (endSolPrice - startSolPrice) / startSolPrice
    : 0;
  const totalHours = totalDays * 24;
  const lendingOnlyReturn = Math.pow(1 + config.lendingApy / 100, totalHours / HOURS_PER_YEAR) - 1;

  return {
    config,
    dailySnapshots,
    totalReturn,
    annualizedReturn,
    sharpeRatio: calcSharpeRatio(dailyReturns),
    maxDrawdown: calcMaxDrawdown(navSeries),
    daysInBaseOnly,
    daysInBaseDn,
    totalEntries,
    totalExits,
    totalFees: portfolio.totalFees,
    totalFundingReceived: portfolio.totalFundingReceived,
    totalLendingInterest: portfolio.totalLendingInterest,
    totalStakingYield: portfolio.totalStakingYield,
    solBuyAndHoldReturn,
    lendingOnlyReturn,
  };
}

function buildVaultConfig(config: BacktestConfig): VaultConfig {
  return {
    general: {
      dryRun: false,
      logLevel: 'silent',
      tickIntervalMs: 0,
      snapshotIntervalMs: 0,
      lendingRebalanceIntervalMs: 0,
      dailyPnlTimeUtc: '00:00',
    },
    binance: {
      symbol: 'SOLUSDT',
      leverage: 1,
      testnet: false,
    },
    solana: {
      network: 'mainnet-beta',
    },
    thresholds: {
      frEntryAnnualized: config.frEntryAnnualized,
      frEntryConfirmationDays: config.confirmDays,
      frExitAnnualized: config.frExitAnnualized,
      frExitConfirmationDays: config.confirmDays,
      frEmergencyAnnualized: config.frEmergencyAnnualized,
      dnAllocationMax: config.dnAllocation,
      lendingRebalanceMinDiffBps: 50,
    },
    risk: {
      dailyLossLimitPct: 5,
      maxPositionCapUsd: 1_000_000,
      maxTransferSizeUsd: 100_000,
      positionDivergenceThresholdPct: 5,
    },
    lending: {
      protocols: [],
      bufferPct: 5,
    },
  };
}

/**
 * Find the FR tick closest to the given price tick time.
 * Uses exact match first, then binary search within 4h tolerance.
 */
function findClosestFr(
  frByTime: Map<number, FrTick>,
  targetTime: number,
  sortedFrTicks: FrTick[],
): FrTick | undefined {
  const exact = frByTime.get(targetTime);
  if (exact) return exact;

  // Binary search for closest
  const tolerance = 4 * 60 * 60 * 1000;
  let lo = 0;
  let hi = sortedFrTicks.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const midTime = sortedFrTicks[mid]!.fundingTime;
    if (midTime < targetTime) lo = mid + 1;
    else if (midTime > targetTime) hi = mid - 1;
    else return sortedFrTicks[mid];
  }

  // Check neighbors
  let closest: FrTick | undefined;
  let minDiff = Infinity;
  for (const idx of [lo - 1, lo, lo + 1]) {
    if (idx >= 0 && idx < sortedFrTicks.length) {
      const diff = Math.abs(sortedFrTicks[idx]!.fundingTime - targetTime);
      if (diff < minDiff && diff <= tolerance) {
        minDiff = diff;
        closest = sortedFrTicks[idx];
      }
    }
  }
  return closest;
}
