import { describe, it, expect } from 'vitest';
import { evaluateState, type StateSignals } from '../../src/core/state-machine.js';
import { BotState, ActionType } from '../../src/types.js';
import type { VaultConfig } from '../../src/types.js';

// ── Test config ────────────────────────────────────────────

const config: VaultConfig = {
  general: {
    dryRun: true,
    logLevel: 'silent',
    tickIntervalMs: 30_000,
    snapshotIntervalMs: 300_000,
    lendingRebalanceIntervalMs: 21_600_000,
    dailyPnlTimeUtc: '00:00',
  },
  perp: {
    exchange: 'binance' as const,
    symbol: 'SOLUSDC',
    leverage: 1,
    swapSlippageBps: 50,
  },
  binance: {
    symbol: 'SOLUSDC',
    leverage: 1,
    testnet: true,
    swapSlippageBps: 50,
  },
  solana: {
    network: 'devnet',
  },
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
  lending: {
    protocols: ['kamino', 'jupiter'],
    bufferPct: 5,
  },
};

function makeSignals(overrides: Partial<StateSignals> = {}): StateSignals {
  return {
    currentState: BotState.BASE_ONLY,
    avgFrAnnualized: 5,
    latestFrAnnualized: 5,
    daysAboveEntry: 0,
    daysBelowExit: 0,
    riskApproved: true,
    dnOperationInProgress: false,
    totalNavUsdc: 20_000,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────

describe('evaluateState', () => {
  // ─ BASE_ONLY stays BASE_ONLY ─────────────────────────────

  it('stays BASE_ONLY when FR is below entry threshold', () => {
    const signals = makeSignals({
      avgFrAnnualized: 5, // below 10
      daysAboveEntry: 0,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_ONLY);
    expect(result.actions).toHaveLength(0);
    expect(result.reason).toContain('Holding BASE_ONLY');
  });

  it('stays BASE_ONLY when FR is above entry but not enough confirmation days', () => {
    const signals = makeSignals({
      avgFrAnnualized: 15,
      daysAboveEntry: 2, // need 3
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_ONLY);
    expect(result.actions).toHaveLength(0);
  });

  // ─ BASE_ONLY → BASE_DN ──────────────────────────────────

  it('transitions BASE_ONLY → BASE_DN when FR above entry for N days', () => {
    const signals = makeSignals({
      avgFrAnnualized: 15,
      latestFrAnnualized: 15,
      daysAboveEntry: 3,
      riskApproved: true,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_DN);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.type).toBe(ActionType.DN_ENTRY);
    expect(result.reason).toContain('FR entry');
  });

  it('transitions BASE_ONLY → BASE_DN when daysAboveEntry exceeds confirmation', () => {
    const signals = makeSignals({
      avgFrAnnualized: 12,
      daysAboveEntry: 5, // well above 3
      riskApproved: true,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_DN);
    expect(result.actions[0]!.type).toBe(ActionType.DN_ENTRY);
  });

  // ─ BASE_DN → BASE_ONLY ──────────────────────────────────

  it('transitions BASE_DN → BASE_ONLY when FR drops below exit for N days', () => {
    const signals = makeSignals({
      currentState: BotState.BASE_DN,
      avgFrAnnualized: -2,
      latestFrAnnualized: -2,
      daysBelowExit: 3,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_ONLY);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.type).toBe(ActionType.DN_EXIT);
    expect(result.reason).toContain('FR exit');
  });

  it('stays BASE_DN when daysBelowExit is insufficient', () => {
    const signals = makeSignals({
      currentState: BotState.BASE_DN,
      avgFrAnnualized: -1,
      latestFrAnnualized: -1,
      daysBelowExit: 2, // need 3
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_DN);
    expect(result.actions).toHaveLength(0);
    expect(result.reason).toContain('Holding BASE_DN');
  });

  // ─ Emergency exit ────────────────────────────────────────

  it('triggers EMERGENCY_EXIT when latest FR < emergency threshold', () => {
    const signals = makeSignals({
      currentState: BotState.BASE_DN,
      latestFrAnnualized: -15, // below -10
      avgFrAnnualized: 5,
      daysBelowExit: 0,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_ONLY);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.type).toBe(ActionType.EMERGENCY_EXIT);
    expect(result.reason).toContain('Emergency exit');
  });

  it('does not trigger emergency exit from BASE_ONLY', () => {
    const signals = makeSignals({
      currentState: BotState.BASE_ONLY,
      latestFrAnnualized: -15,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_ONLY);
    // Should NOT have an EMERGENCY_EXIT action — we're already BASE_ONLY
    expect(result.actions.some((a) => a.type === ActionType.EMERGENCY_EXIT)).toBe(false);
  });

  it('emergency exit takes priority over normal exit check', () => {
    const signals = makeSignals({
      currentState: BotState.BASE_DN,
      latestFrAnnualized: -15,
      daysBelowExit: 5, // would also trigger normal exit
    });

    const result = evaluateState(signals, config);

    expect(result.actions[0]!.type).toBe(ActionType.EMERGENCY_EXIT);
  });

  // ─ forceState override ──────────────────────────────────

  it('forces state transition via forceState override', () => {
    const signals = makeSignals({
      currentState: BotState.BASE_ONLY,
      avgFrAnnualized: 0, // wouldn't normally transition
      forceState: BotState.BASE_DN,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_DN);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.type).toBe(ActionType.DN_ENTRY);
    expect(result.actions[0]!.params).toHaveProperty('forced', true);
    expect(result.reason).toContain('Manual override');
  });

  it('forces exit via forceState override from BASE_DN', () => {
    const signals = makeSignals({
      currentState: BotState.BASE_DN,
      forceState: BotState.BASE_ONLY,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_ONLY);
    expect(result.actions[0]!.type).toBe(ActionType.DN_EXIT);
    expect(result.actions[0]!.params).toHaveProperty('forced', true);
  });

  it('ignores forceState when it matches currentState', () => {
    const signals = makeSignals({
      currentState: BotState.BASE_ONLY,
      forceState: BotState.BASE_ONLY,
      avgFrAnnualized: 5,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_ONLY);
    expect(result.actions).toHaveLength(0);
    expect(result.reason).not.toContain('Manual override');
  });

  // ─ dnOperationInProgress ─────────────────────────────────

  it('blocks entry when dnOperationInProgress is true', () => {
    const signals = makeSignals({
      avgFrAnnualized: 15,
      daysAboveEntry: 5,
      riskApproved: true,
      dnOperationInProgress: true,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_ONLY);
    expect(result.actions).toHaveLength(0);
    expect(result.reason).toContain('DN operation already in progress');
  });

  it('blocks exit when dnOperationInProgress is true (non-emergency)', () => {
    const signals = makeSignals({
      currentState: BotState.BASE_DN,
      daysBelowExit: 5,
      latestFrAnnualized: 2, // above emergency threshold
      dnOperationInProgress: true,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_DN);
    expect(result.actions).toHaveLength(0);
    expect(result.reason).toContain('DN operation already in progress');
  });

  // ─ riskApproved ──────────────────────────────────────────

  it('blocks entry when riskApproved is false', () => {
    const signals = makeSignals({
      avgFrAnnualized: 15,
      daysAboveEntry: 5,
      riskApproved: false,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_ONLY);
    expect(result.actions).toHaveLength(0);
    expect(result.reason).toContain('Risk manager has not approved');
  });

  // ─ Edge cases ────────────────────────────────────────────

  it('includes relevant params in DN_ENTRY action', () => {
    const signals = makeSignals({
      avgFrAnnualized: 20,
      daysAboveEntry: 4,
      riskApproved: true,
    });

    const result = evaluateState(signals, config);
    const action = result.actions[0]!;

    expect(action.params).toMatchObject({
      avgFrAnnualized: 20,
      daysAboveEntry: 4,
      entryThreshold: 10,
      confirmationDays: 3,
    });
    expect(action.timestamp).toBeGreaterThan(0);
  });

  it('handles FR exactly at entry threshold (not above)', () => {
    const signals = makeSignals({
      avgFrAnnualized: 10, // equal, not above
      daysAboveEntry: 5,
      riskApproved: true,
    });

    const result = evaluateState(signals, config);

    // avgFR must be strictly greater than threshold
    expect(result.nextState).toBe(BotState.BASE_ONLY);
    expect(result.actions).toHaveLength(0);
  });

  // ─ usdcAmount in DN_ENTRY ──────────────────────────────

  it('DN_ENTRY includes usdcAmount = min(nav * dnAllocationMax, maxPositionCapUsd)', () => {
    // nav=20000, dnAllocationMax=0.7 → 14000, maxPositionCapUsd=10000 → min=10000
    const signals = makeSignals({
      avgFrAnnualized: 15,
      daysAboveEntry: 3,
      riskApproved: true,
      totalNavUsdc: 20_000,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_DN);
    expect(result.actions[0]!.params).toHaveProperty('usdcAmount', 10_000);
  });

  it('DN_ENTRY usdcAmount capped by nav * dnAllocationMax when lower than maxPositionCapUsd', () => {
    // nav=5000, dnAllocationMax=0.7 → 3500, maxPositionCapUsd=10000 → min=3500
    const signals = makeSignals({
      avgFrAnnualized: 15,
      daysAboveEntry: 3,
      riskApproved: true,
      totalNavUsdc: 5_000,
    });

    const result = evaluateState(signals, config);

    expect(result.nextState).toBe(BotState.BASE_DN);
    expect(result.actions[0]!.params).toHaveProperty('usdcAmount', 3_500);
  });

  it('forced DN_ENTRY includes usdcAmount', () => {
    const signals = makeSignals({
      currentState: BotState.BASE_ONLY,
      forceState: BotState.BASE_DN,
      totalNavUsdc: 20_000,
    });

    const result = evaluateState(signals, config);

    expect(result.actions[0]!.type).toBe(ActionType.DN_ENTRY);
    expect(result.actions[0]!.params).toHaveProperty('usdcAmount', 10_000);
  });
});
