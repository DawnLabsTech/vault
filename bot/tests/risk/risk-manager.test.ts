import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { RiskManager } from '../../src/risk/risk-manager.js';
import { ActionType, BotState } from '../../src/types.js';
import type { Action, PortfolioSnapshot, VaultConfig } from '../../src/types.js';

const KILL_SWITCH_PATH = '/tmp/vault-kill';

function cleanupKillSwitch() {
  if (existsSync(KILL_SWITCH_PATH)) {
    unlinkSync(KILL_SWITCH_PATH);
  }
}

const config: VaultConfig = {
  general: {
    dryRun: true,
    logLevel: 'silent',
    tickIntervalMs: 30_000,
    snapshotIntervalMs: 300_000,
    lendingRebalanceIntervalMs: 21_600_000,
    dailyPnlTimeUtc: '00:00',
  },
  perp: { exchange: 'binance' as const, symbol: 'SOLUSDC', leverage: 1, swapSlippageBps: 50 },
  binance: { symbol: 'SOLUSDC', leverage: 1, testnet: true, swapSlippageBps: 50 },
  solana: { network: 'devnet' },
  thresholds: {
    frEntryAnnualized: 10,
    frEntryConfirmationDays: 3,
    frExitAnnualized: 0,
    frExitConfirmationDays: 3,
    frEmergencyAnnualized: -10,
    dnAllocationMax: 0.7,
    lendingRebalanceMinDiffBps: 50,
  },
  risk: {
    dailyLossLimitPct: 2,
    maxPositionCapUsd: 10_000,
    maxTransferSizeUsd: 5_000,
    positionDivergenceThresholdPct: 3,
  },
  lending: { protocols: ['kamino', 'drift', 'jupiter'], bufferPct: 5 },
};

function makeSnapshot(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    timestamp: new Date().toISOString(),
    totalNavUsdc: 20_000,
    lendingBalance: 15_000,
    lendingBreakdown: { kamino: 15_000 },
    dawnsolBalance: 0,
    dawnsolUsdcValue: 0,
    binanceUsdcBalance: 5_000,
    binancePerpUnrealizedPnl: 0,
    binancePerpSize: 0,
    state: BotState.BASE_ONLY,
    solPrice: 150,
    dawnsolPrice: 160,
    ...overrides,
  };
}

function makeAction(type: ActionType, params: Record<string, unknown> = {}): Action {
  return { type, params, timestamp: Date.now() };
}

// ── preTradeCheck ────────────────────────────────────────

describe('RiskManager.preTradeCheck', () => {
  let rm: RiskManager;

  beforeEach(() => {
    cleanupKillSwitch();
    rm = new RiskManager(config, 20_000);
  });
  afterEach(cleanupKillSwitch);

  it('approves DN_ENTRY within position cap', () => {
    const action = makeAction(ActionType.DN_ENTRY, { usdcAmount: 8_000 });
    const result = rm.preTradeCheck(action, makeSnapshot());
    expect(result.approved).toBe(true);
  });

  it('rejects DN_ENTRY exceeding position cap', () => {
    const action = makeAction(ActionType.DN_ENTRY, { usdcAmount: 15_000 });
    const result = rm.preTradeCheck(action, makeSnapshot());
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('position cap');
  });

  it('always approves DN_EXIT', () => {
    const action = makeAction(ActionType.DN_EXIT);
    const result = rm.preTradeCheck(action, makeSnapshot());
    expect(result.approved).toBe(true);
  });

  it('always approves EMERGENCY_EXIT', () => {
    const action = makeAction(ActionType.EMERGENCY_EXIT);
    const result = rm.preTradeCheck(action, makeSnapshot());
    expect(result.approved).toBe(true);
  });

  it('always approves REBALANCE_LENDING', () => {
    const action = makeAction(ActionType.REBALANCE_LENDING);
    const result = rm.preTradeCheck(action, makeSnapshot());
    expect(result.approved).toBe(true);
  });

  it('rejects when kill switch is active', () => {
    try {
      writeFileSync(KILL_SWITCH_PATH, '');
      const action = makeAction(ActionType.DN_ENTRY, { usdcAmount: 1_000 });
      const result = rm.preTradeCheck(action, makeSnapshot());
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Kill switch');
    } finally {
      if (existsSync(KILL_SWITCH_PATH)) unlinkSync(KILL_SWITCH_PATH);
    }
  });

  it('rejects DN_ENTRY when daily loss limit is breached', () => {
    const action = makeAction(ActionType.DN_ENTRY, { usdcAmount: 5_000 });
    // NAV dropped from 20000 to 19000 = 5% loss > 2% limit
    const snapshot = makeSnapshot({ totalNavUsdc: 19_000 });
    const result = rm.preTradeCheck(action, snapshot);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Daily loss limit');
  });

  it('approves DN_ENTRY with zero usdcAmount (defaults to 0)', () => {
    const action = makeAction(ActionType.DN_ENTRY, {});
    const result = rm.preTradeCheck(action, makeSnapshot());
    expect(result.approved).toBe(true);
  });
});

// ── continuousMonitor ────────────────────────────────────

describe('RiskManager.continuousMonitor', () => {
  let rm: RiskManager;

  beforeEach(() => {
    cleanupKillSwitch();
    rm = new RiskManager(config, 20_000);
  });
  afterEach(cleanupKillSwitch);

  it('returns no alerts when portfolio is healthy', () => {
    const result = rm.continuousMonitor(makeSnapshot());
    expect(result.alerts).toHaveLength(0);
    expect(result.actions).toHaveLength(0);
  });

  it('returns critical alert + emergency exit on kill switch', () => {
    writeFileSync(KILL_SWITCH_PATH, '');
    const result = rm.continuousMonitor(makeSnapshot());
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.level).toBe('critical');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.type).toBe(ActionType.EMERGENCY_EXIT);
  });

  it('returns critical alert + emergency exit on daily loss in BASE_DN', () => {
    // 5% loss > 2% limit, state BASE_DN
    const snapshot = makeSnapshot({
      totalNavUsdc: 19_000,
      state: BotState.BASE_DN,
    });
    const result = rm.continuousMonitor(snapshot);
    expect(result.alerts.some(a => a.level === 'critical')).toBe(true);
    expect(result.actions.some(a => a.type === ActionType.EMERGENCY_EXIT)).toBe(true);
  });

  it('returns critical alert but NO emergency exit on daily loss in BASE_ONLY', () => {
    const snapshot = makeSnapshot({
      totalNavUsdc: 19_000,
      state: BotState.BASE_ONLY,
    });
    const result = rm.continuousMonitor(snapshot);
    expect(result.alerts.some(a => a.level === 'critical')).toBe(true);
    expect(result.actions).toHaveLength(0); // no DN position to exit
  });

  it('returns warning when approaching daily loss limit (70%)', () => {
    // 1.5% loss → 75% of 2% limit → warning
    const snapshot = makeSnapshot({ totalNavUsdc: 19_700 });
    const result = rm.continuousMonitor(snapshot);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.level).toBe('warning');
    expect(result.alerts[0]!.message).toContain('Approaching');
  });

  it('returns warning on position divergence in BASE_DN', () => {
    // dawnSOL value: 10 * 160 = 1600, solPrice 150 → spotSolEq = 1600/150 = 10.67
    // perpSize = 15 → divergence = |10.67 - 15| / 15 = 28.9% > 3%
    const snapshot = makeSnapshot({
      state: BotState.BASE_DN,
      dawnsolBalance: 10,
      dawnsolPrice: 160,
      solPrice: 150,
      binancePerpSize: 15,
    });
    const result = rm.continuousMonitor(snapshot);
    expect(result.alerts.some(a => a.message.includes('divergence'))).toBe(true);
  });

  it('skips position divergence check in BASE_ONLY', () => {
    const snapshot = makeSnapshot({
      state: BotState.BASE_ONLY,
      dawnsolBalance: 10,
      binancePerpSize: 15,
    });
    const result = rm.continuousMonitor(snapshot);
    // No divergence alert because we're in BASE_ONLY
    expect(result.alerts.some(a => a.message.includes('divergence'))).toBe(false);
  });
});

// ── setDayStartNav ───────────────────────────────────────

describe('RiskManager.setDayStartNav', () => {
  beforeEach(cleanupKillSwitch);
  afterEach(cleanupKillSwitch);

  it('updates day start NAV and affects loss calculation', () => {
    const rm = new RiskManager(config, 10_000);

    // 5% loss from 10000
    const action = makeAction(ActionType.DN_ENTRY, { usdcAmount: 5_000 });
    const snapshot = makeSnapshot({ totalNavUsdc: 9_500 });
    expect(rm.preTradeCheck(action, snapshot).approved).toBe(false);

    // Update day start NAV to 9500 → now 0% loss
    rm.setDayStartNav(9_500);
    expect(rm.preTradeCheck(action, snapshot).approved).toBe(true);
  });
});
