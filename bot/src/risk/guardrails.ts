import { existsSync } from 'fs';
import { createChildLogger } from '../utils/logger.js';
import { round } from '../utils/math.js';

const log = createChildLogger('guardrails');

export const KILL_SWITCH_PATH =
  process.env.VAULT_KILL_SWITCH_PATH ?? '/tmp/vault-kill';

// ── Result types ───────────────────────────────────────────────────────────

export interface GuardrailResult {
  ok: boolean;
  reason: string;
  action: 'block' | 'warn' | 'kill';
}

// ── Individual checks ──────────────────────────────────────────────────────

/**
 * Check if the daily loss exceeds the allowed limit.
 */
export function checkDailyLossLimit(
  currentNav: number,
  dayStartNav: number,
  limitPct: number,
): { ok: boolean; lossPct: number } {
  if (dayStartNav <= 0) {
    return { ok: true, lossPct: 0 };
  }
  const lossPct = round(((dayStartNav - currentNav) / dayStartNav) * 100, 4);
  const ok = lossPct < limitPct;
  if (!ok) {
    log.warn(
      { lossPct, limitPct, currentNav, dayStartNav },
      'Daily loss limit breached',
    );
  }
  return { ok, lossPct };
}

/**
 * Check if a proposed position size is within limits.
 * Returns the maximum allowed size (capped to the smaller of maxCap
 * and maxAllocationPct of totalNav).
 */
export function checkMaxPositionCap(
  proposedSize: number,
  maxCap: number,
  totalNav: number,
  maxAllocationPct: number,
): { ok: boolean; allowedSize: number } {
  const allocationLimit = round(totalNav * maxAllocationPct, 6);
  const effectiveCap = Math.min(maxCap, allocationLimit);
  const allowedSize = Math.min(proposedSize, effectiveCap);
  const ok = proposedSize <= effectiveCap;
  if (!ok) {
    log.warn(
      { proposedSize, effectiveCap, maxCap, allocationLimit },
      'Position cap exceeded, capping size',
    );
  }
  return { ok, allowedSize: round(allowedSize, 6) };
}

/**
 * Check if a transfer amount exceeds the max single transfer size.
 * If it does, split into multiple smaller transfers.
 */
export function checkMaxTransferSize(
  amount: number,
  maxSize: number,
): { ok: boolean; splitAmounts: number[] } {
  if (amount <= maxSize) {
    return { ok: true, splitAmounts: [amount] };
  }

  const splitAmounts: number[] = [];
  let remaining = amount;
  while (remaining > 0) {
    const chunk = Math.min(remaining, maxSize);
    splitAmounts.push(round(chunk, 6));
    remaining = round(remaining - chunk, 6);
  }

  log.warn(
    { amount, maxSize, chunks: splitAmounts.length },
    'Transfer exceeds max size, splitting',
  );
  return { ok: false, splitAmounts };
}

/**
 * Check if the spot (dawnSOL-equivalent SOL) and PERP short positions
 * have diverged beyond the acceptable threshold.
 */
export function checkPositionDivergence(
  spotSol: number,
  shortSol: number,
  thresholdPct: number,
): { ok: boolean; divergencePct: number } {
  if (spotSol === 0 && shortSol === 0) {
    return { ok: true, divergencePct: 0 };
  }

  const reference = Math.max(spotSol, shortSol);
  if (reference === 0) {
    return { ok: true, divergencePct: 0 };
  }

  const divergencePct = round(
    (Math.abs(spotSol - shortSol) / reference) * 100,
    4,
  );
  const ok = divergencePct <= thresholdPct;

  if (!ok) {
    log.warn(
      { spotSol, shortSol, divergencePct, thresholdPct },
      'Position divergence threshold exceeded',
    );
  }

  return { ok, divergencePct };
}

/**
 * Check if the kill switch file exists.
 * Touch /tmp/vault-kill to trigger an emergency shutdown.
 */
export function checkKillSwitch(path: string = KILL_SWITCH_PATH): boolean {
  const killed = existsSync(path);
  if (killed) {
    log.error(`Kill switch activated — ${path} exists`);
  }
  return killed;
}

/**
 * Run all guardrails and return a composite result.
 */
export function runAllGuardrails(params: {
  currentNav: number;
  dayStartNav: number;
  dailyLossLimitPct: number;
  spotSol: number;
  shortSol: number;
  positionDivergenceThresholdPct: number;
}): GuardrailResult {
  // Kill switch — highest priority
  if (checkKillSwitch()) {
    return {
      ok: false,
      reason: 'Kill switch activated (/tmp/vault-kill exists)',
      action: 'kill',
    };
  }

  // Daily loss limit
  const lossCheck = checkDailyLossLimit(
    params.currentNav,
    params.dayStartNav,
    params.dailyLossLimitPct,
  );
  if (!lossCheck.ok) {
    return {
      ok: false,
      reason: `Daily loss limit breached: ${lossCheck.lossPct}% >= ${params.dailyLossLimitPct}%`,
      action: 'block',
    };
  }

  // Position divergence
  const divCheck = checkPositionDivergence(
    params.spotSol,
    params.shortSol,
    params.positionDivergenceThresholdPct,
  );
  if (!divCheck.ok) {
    return {
      ok: false,
      reason: `Position divergence: ${divCheck.divergencePct}% > ${params.positionDivergenceThresholdPct}%`,
      action: 'warn',
    };
  }

  return { ok: true, reason: '', action: 'warn' };
}
