import { frToAnnualized } from '@bot/utils/math.js';
import type { FrTick } from '../types.js';

interface FrSignals {
  avgFrAnnualized: number;
  latestFrAnnualized: number;
  daysAboveEntry: number;
  daysBelowExit: number;
}

/**
 * Build state signals from in-memory FR data.
 * Replicates FrMonitor's countConsecutiveDays logic without SQLite dependency.
 *
 * @param frHistory All FR ticks up to current tick, sorted ascending by time
 * @param entryThreshold Annualized FR % for entry
 * @param exitThreshold Annualized FR % for exit
 * @param avgDays Number of days to average over
 */
export function buildFrSignals(
  frHistory: FrTick[],
  entryThreshold: number,
  exitThreshold: number,
  avgDays: number = 7,
): FrSignals {
  if (frHistory.length === 0) {
    return { avgFrAnnualized: 0, latestFrAnnualized: 0, daysAboveEntry: 0, daysBelowExit: 0 };
  }

  const latest = frHistory[frHistory.length - 1]!;
  const latestFrAnnualized = frToAnnualized(latest.fundingRate);

  // Average over last N days (N*3 ticks)
  const avgTicks = Math.min(frHistory.length, avgDays * 3);
  const recentSlice = frHistory.slice(-avgTicks);
  const avgFrAnnualized = recentSlice.reduce(
    (sum, t) => sum + frToAnnualized(t.fundingRate), 0,
  ) / recentSlice.length;

  // Group by UTC date for consecutive day counting
  const dayMap = groupByUtcDate(frHistory);

  const daysAboveEntry = countConsecutiveDays(dayMap, entryThreshold, 'above');
  const daysBelowExit = countConsecutiveDays(dayMap, exitThreshold, 'below');

  return { avgFrAnnualized, latestFrAnnualized, daysAboveEntry, daysBelowExit };
}

/**
 * Group FR ticks by UTC date string (YYYY-MM-DD).
 * Returns entries sorted by date descending (most recent first).
 */
function groupByUtcDate(ticks: FrTick[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const tick of ticks) {
    const date = new Date(tick.fundingTime).toISOString().slice(0, 10);
    const annualized = frToAnnualized(tick.fundingRate);
    const existing = map.get(date);
    if (existing) {
      existing.push(annualized);
    } else {
      map.set(date, [annualized]);
    }
  }
  return map;
}

/**
 * Count consecutive qualifying days from most recent backwards.
 * Mirrors FrMonitor.countConsecutiveDays logic:
 * - "above": day qualifies if MIN(annualized) > threshold
 * - "below": day qualifies if MAX(annualized) < threshold
 */
function countConsecutiveDays(
  dayMap: Map<string, number[]>,
  threshold: number,
  direction: 'above' | 'below',
): number {
  // Sort dates descending
  const dates = [...dayMap.keys()].sort().reverse();

  let count = 0;
  for (const date of dates) {
    const rates = dayMap.get(date)!;
    const qualifies = direction === 'above'
      ? Math.min(...rates) > threshold
      : Math.max(...rates) < threshold;

    if (qualifies) {
      count++;
    } else {
      break;
    }
  }
  return count;
}
