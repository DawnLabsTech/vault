import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkDailyLossLimit,
  checkMaxPositionCap,
  checkMaxTransferSize,
  checkPositionDivergence,
  checkKillSwitch,
  runAllGuardrails,
} from '../../src/risk/guardrails.js';

// Use a temp dir for kill switch tests to avoid sandbox restrictions
let killSwitchPath: string;

function setupKillSwitchDir() {
  const dir = mkdtempSync(join(tmpdir(), 'vault-test-'));
  killSwitchPath = join(dir, 'vault-kill');
}

function cleanupKillSwitch() {
  if (existsSync(killSwitchPath)) {
    unlinkSync(killSwitchPath);
  }
}

// ── checkDailyLossLimit ──────────────────────────────────

describe('checkDailyLossLimit', () => {
  it('returns ok when no loss', () => {
    const result = checkDailyLossLimit(10_000, 10_000, 2);
    expect(result.ok).toBe(true);
    expect(result.lossPct).toBe(0);
  });

  it('returns ok when loss is below limit', () => {
    // 1% loss, limit 2%
    const result = checkDailyLossLimit(9_900, 10_000, 2);
    expect(result.ok).toBe(true);
    expect(result.lossPct).toBe(1);
  });

  it('returns not ok when loss equals limit', () => {
    // 2% loss, limit 2%
    const result = checkDailyLossLimit(9_800, 10_000, 2);
    expect(result.ok).toBe(false);
    expect(result.lossPct).toBe(2);
  });

  it('returns not ok when loss exceeds limit', () => {
    const result = checkDailyLossLimit(9_500, 10_000, 2);
    expect(result.ok).toBe(false);
    expect(result.lossPct).toBe(5);
  });

  it('returns ok when NAV increases (profit)', () => {
    const result = checkDailyLossLimit(10_500, 10_000, 2);
    expect(result.ok).toBe(true);
    expect(result.lossPct).toBe(-5); // negative = profit
  });

  it('returns ok when dayStartNav is 0 (not set)', () => {
    const result = checkDailyLossLimit(10_000, 0, 2);
    expect(result.ok).toBe(true);
    expect(result.lossPct).toBe(0);
  });

  it('returns ok when dayStartNav is negative', () => {
    const result = checkDailyLossLimit(10_000, -1, 2);
    expect(result.ok).toBe(true);
    expect(result.lossPct).toBe(0);
  });
});

// ── checkMaxPositionCap ──────────────────────────────────

describe('checkMaxPositionCap', () => {
  it('returns ok when proposed size is within both limits', () => {
    // NAV 20000, allocation 0.7 → 14000, cap 10000 → effective 10000
    const result = checkMaxPositionCap(8_000, 10_000, 20_000, 0.7);
    expect(result.ok).toBe(true);
    expect(result.allowedSize).toBe(8_000);
  });

  it('returns not ok when proposed size exceeds cap', () => {
    const result = checkMaxPositionCap(12_000, 10_000, 20_000, 0.7);
    expect(result.ok).toBe(false);
    expect(result.allowedSize).toBe(10_000);
  });

  it('caps by allocation limit when it is lower than maxCap', () => {
    // NAV 5000, allocation 0.7 → 3500, cap 10000 → effective 3500
    const result = checkMaxPositionCap(5_000, 10_000, 5_000, 0.7);
    expect(result.ok).toBe(false);
    expect(result.allowedSize).toBe(3_500);
  });

  it('returns ok when proposed exactly matches effective cap', () => {
    const result = checkMaxPositionCap(10_000, 10_000, 20_000, 0.7);
    expect(result.ok).toBe(true);
    expect(result.allowedSize).toBe(10_000);
  });

  it('handles zero NAV', () => {
    const result = checkMaxPositionCap(1_000, 10_000, 0, 0.7);
    expect(result.ok).toBe(false);
    expect(result.allowedSize).toBe(0);
  });
});

// ── checkMaxTransferSize ─────────────────────────────────

describe('checkMaxTransferSize', () => {
  it('returns ok when amount is within max size', () => {
    const result = checkMaxTransferSize(3_000, 5_000);
    expect(result.ok).toBe(true);
    expect(result.splitAmounts).toEqual([3_000]);
  });

  it('returns ok when amount equals max size', () => {
    const result = checkMaxTransferSize(5_000, 5_000);
    expect(result.ok).toBe(true);
    expect(result.splitAmounts).toEqual([5_000]);
  });

  it('splits into 2 chunks when amount exceeds max size', () => {
    const result = checkMaxTransferSize(8_000, 5_000);
    expect(result.ok).toBe(false);
    expect(result.splitAmounts).toEqual([5_000, 3_000]);
  });

  it('splits into 3 chunks for large amount', () => {
    const result = checkMaxTransferSize(12_000, 5_000);
    expect(result.ok).toBe(false);
    expect(result.splitAmounts).toHaveLength(3);
    expect(result.splitAmounts.reduce((a, b) => a + b, 0)).toBe(12_000);
  });

  it('handles exact multiples', () => {
    const result = checkMaxTransferSize(10_000, 5_000);
    expect(result.ok).toBe(false);
    expect(result.splitAmounts).toEqual([5_000, 5_000]);
  });
});

// ── checkPositionDivergence ──────────────────────────────

describe('checkPositionDivergence', () => {
  it('returns ok when positions are equal', () => {
    const result = checkPositionDivergence(10, 10, 3);
    expect(result.ok).toBe(true);
    expect(result.divergencePct).toBe(0);
  });

  it('returns ok when divergence is within threshold', () => {
    // 10 vs 10.2 → 2% divergence, threshold 3%
    const result = checkPositionDivergence(10, 10.2, 3);
    expect(result.ok).toBe(true);
    expect(result.divergencePct).toBeLessThan(3);
  });

  it('returns not ok when divergence exceeds threshold', () => {
    // 10 vs 11 → 9.09% divergence, threshold 3%
    const result = checkPositionDivergence(10, 11, 3);
    expect(result.ok).toBe(false);
    expect(result.divergencePct).toBeGreaterThan(3);
  });

  it('returns ok when both positions are zero', () => {
    const result = checkPositionDivergence(0, 0, 3);
    expect(result.ok).toBe(true);
    expect(result.divergencePct).toBe(0);
  });

  it('handles one side being zero', () => {
    const result = checkPositionDivergence(10, 0, 3);
    expect(result.ok).toBe(false);
    expect(result.divergencePct).toBe(100);
  });

  it('returns ok at exactly the threshold', () => {
    // divergence == threshold → ok (<=)
    const result = checkPositionDivergence(100, 97, 3);
    expect(result.ok).toBe(true);
    expect(result.divergencePct).toBe(3);
  });
});

// ── checkKillSwitch ──────────────────────────────────────

describe('checkKillSwitch', () => {
  beforeEach(setupKillSwitchDir);
  afterEach(cleanupKillSwitch);

  it('returns false when kill switch file does not exist', () => {
    expect(checkKillSwitch(killSwitchPath)).toBe(false);
  });

  it('returns true when kill switch file exists', () => {
    writeFileSync(killSwitchPath, '');
    expect(checkKillSwitch(killSwitchPath)).toBe(true);
  });
});

// ── runAllGuardrails ─────────────────────────────────────

describe('runAllGuardrails', () => {
  beforeEach(setupKillSwitchDir);
  afterEach(cleanupKillSwitch);

  it('returns ok when all checks pass', () => {
    const result = runAllGuardrails({
      currentNav: 10_000,
      dayStartNav: 10_000,
      dailyLossLimitPct: 2,
      spotSol: 10,
      shortSol: 10,
      positionDivergenceThresholdPct: 3,
      killSwitchPath,
    });
    expect(result.ok).toBe(true);
  });

  it('returns kill when kill switch is active', () => {
    writeFileSync(killSwitchPath, '');
    const result = runAllGuardrails({
      currentNav: 10_000,
      dayStartNav: 10_000,
      dailyLossLimitPct: 2,
      spotSol: 10,
      shortSol: 10,
      positionDivergenceThresholdPct: 3,
      killSwitchPath,
    });
    expect(result.ok).toBe(false);
    expect(result.action).toBe('kill');
  });

  it('returns block when daily loss limit is breached', () => {
    const result = runAllGuardrails({
      currentNav: 9_500,
      dayStartNav: 10_000,
      dailyLossLimitPct: 2,
      spotSol: 10,
      shortSol: 10,
      positionDivergenceThresholdPct: 3,
      killSwitchPath,
    });
    expect(result.ok).toBe(false);
    expect(result.action).toBe('block');
  });

  it('returns warn when position divergence exceeds threshold', () => {
    const result = runAllGuardrails({
      currentNav: 10_000,
      dayStartNav: 10_000,
      dailyLossLimitPct: 2,
      spotSol: 10,
      shortSol: 15,
      positionDivergenceThresholdPct: 3,
      killSwitchPath,
    });
    expect(result.ok).toBe(false);
    expect(result.action).toBe('warn');
  });

  it('kill switch takes priority over other checks', () => {
    writeFileSync(killSwitchPath, '');
    const result = runAllGuardrails({
      currentNav: 9_000, // also triggers loss limit
      dayStartNav: 10_000,
      dailyLossLimitPct: 2,
      spotSol: 10,
      shortSol: 20, // also triggers divergence
      positionDivergenceThresholdPct: 3,
      killSwitchPath,
    });
    expect(result.action).toBe('kill');
  });

  it('daily loss takes priority over position divergence', () => {
    const result = runAllGuardrails({
      currentNav: 9_500,
      dayStartNav: 10_000,
      dailyLossLimitPct: 2,
      spotSol: 10,
      shortSol: 20, // also triggers divergence
      positionDivergenceThresholdPct: 3,
      killSwitchPath,
    });
    expect(result.action).toBe('block');
  });
});
