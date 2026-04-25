import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { BotState } from '../../src/types.js';
import type { PortfolioSnapshot, VaultConfig } from '../../src/types.js';

const mocks = vi.hoisted(() => {
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
      exchange: 'binance',
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
      maxProtocolAllocationPct: 60,
    },
  };

  return {
    config,
    sendAlert: vi.fn(),
    recordEvent: vi.fn(),
    getStateJson: vi.fn(() => null),
    setStateJson: vi.fn(),
  };
});

vi.mock('../../src/config.js', () => ({
  getConfig: () => mocks.config,
  configManager: { on: vi.fn() },
}));

vi.mock('../../src/utils/notify.js', () => ({
  sendAlert: mocks.sendAlert,
}));

vi.mock('../../src/measurement/events.js', () => ({
  recordEvent: mocks.recordEvent,
}));

vi.mock('../../src/measurement/state-store.js', () => ({
  getStateJson: mocks.getStateJson,
  setStateJson: mocks.setStateJson,
}));

function makeSnapshot(): PortfolioSnapshot {
  return {
    timestamp: new Date().toISOString(),
    totalNavUsdc: 20_000,
    lendingBalance: 0,
    lendingBreakdown: {},
    multiplyBalance: 0,
    multiplyBreakdown: {},
    dawnsolBalance: 0,
    dawnsolUsdcValue: 0,
    bufferUsdcBalance: 0,
    binanceUsdcBalance: 0,
    binancePerpUnrealizedPnl: 0,
    binancePerpSize: 0,
    state: BotState.BASE_ONLY,
    solPrice: 150,
    dawnsolPrice: 155,
  };
}

function createOrchestrator(): Orchestrator {
  const orchestrator = new Orchestrator({
    binanceRest: null,
    binanceWs: null,
    frMonitor: {
      getAverageAnnualized: vi.fn().mockReturnValue(15),
      getLatestAnnualized: vi.fn().mockReturnValue(15),
      getDaysAboveThreshold: vi.fn().mockReturnValue(3),
      getDaysBelowThreshold: vi.fn().mockReturnValue(0),
    } as any,
    baseAllocator: {} as any,
    capitalAllocator: null,
    dnExecutor: {
      getState: vi.fn().mockReturnValue({ currentStep: 'IDLE' }),
    } as any,
    riskManager: {} as any,
    solanaRpc: {} as any,
    walletAddress: 'wallet',
  });

  const timer = (orchestrator as any).dailyPnlTimer as ReturnType<typeof setTimeout> | null;
  if (timer) {
    clearTimeout(timer);
    (orchestrator as any).dailyPnlTimer = null;
  }

  return orchestrator;
}

describe('Orchestrator state commits', () => {
  beforeEach(() => {
    mocks.sendAlert.mockReset();
    mocks.recordEvent.mockReset();
    mocks.getStateJson.mockReset();
    mocks.getStateJson.mockReturnValue(null);
    mocks.setStateJson.mockReset();
  });

  it('does not commit state when action execution fails', async () => {
    const orchestrator = createOrchestrator();
    vi.spyOn(orchestrator as any, 'getOrBuildSnapshot').mockResolvedValue(makeSnapshot());
    vi.spyOn(orchestrator as any, 'executeAction').mockResolvedValue({
      success: false,
      reason: 'blocked',
    });

    await (orchestrator as any).evaluateAndAct();

    expect(orchestrator.getBotState()).toBe(BotState.BASE_ONLY);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it('commits state only after action execution succeeds', async () => {
    const orchestrator = createOrchestrator();
    vi.spyOn(orchestrator as any, 'getOrBuildSnapshot').mockResolvedValue(makeSnapshot());
    vi.spyOn(orchestrator as any, 'executeAction').mockResolvedValue({
      success: true,
    });

    await (orchestrator as any).evaluateAndAct();

    expect(orchestrator.getBotState()).toBe(BotState.BASE_DN);
    expect(mocks.recordEvent).toHaveBeenCalledTimes(1);
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    expect(mocks.setStateJson).toHaveBeenCalled();
  });
});

describe('Orchestrator checkKaminoLoopHealth — utilization warning', () => {
  function makeLoopMock(opts: { health: number; utilization: number | null }) {
    return {
      getHealthRate: vi.fn().mockResolvedValue(opts.health),
      getSupplyUtilization: vi.fn().mockResolvedValue(opts.utilization),
      getLoopConfig: vi.fn().mockReturnValue({
        targetHealthRate: 1.15,
        liquidationLtv: 0.85,
        alertHealthRate: 1.10,
        emergencyHealthRate: 1.05,
        warnUtilizationRatio: 0.95,
      }),
      emergencyDeleverage: vi.fn(),
    };
  }

  function createOrchestratorWithLoop(loopMock: ReturnType<typeof makeLoopMock>): Orchestrator {
    const orchestrator = new Orchestrator({
      binanceRest: null,
      binanceWs: null,
      frMonitor: {
        getAverageAnnualized: vi.fn().mockReturnValue(15),
        getLatestAnnualized: vi.fn().mockReturnValue(15),
        getDaysAboveThreshold: vi.fn().mockReturnValue(3),
        getDaysBelowThreshold: vi.fn().mockReturnValue(0),
      } as any,
      baseAllocator: {} as any,
      capitalAllocator: null,
      dnExecutor: {
        getState: vi.fn().mockReturnValue({ currentStep: 'IDLE' }),
      } as any,
      riskManager: {} as any,
      solanaRpc: {} as any,
      walletAddress: 'wallet',
      kaminoLoop: loopMock as any,
    });
    const timer = (orchestrator as any).dailyPnlTimer;
    if (timer) {
      clearTimeout(timer);
      (orchestrator as any).dailyPnlTimer = null;
    }
    return orchestrator;
  }

  beforeEach(() => {
    mocks.sendAlert.mockReset();
    mocks.recordEvent.mockReset();
    mocks.getStateJson.mockReset();
    mocks.getStateJson.mockReturnValue(null);
    mocks.setStateJson.mockReset();
  });

  it('sends warning when USDC utilization exceeds threshold', async () => {
    const loop = makeLoopMock({ health: 1.20, utilization: 0.97 });
    const orchestrator = createOrchestratorWithLoop(loop);

    await (orchestrator as any).checkKaminoLoopHealth();

    expect(loop.getSupplyUtilization).toHaveBeenCalledTimes(1);
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    const [message, severity] = mocks.sendAlert.mock.calls[0];
    expect(message).toContain('97.0%');
    expect(message).toContain('withdrawals may be queued');
    expect(severity).toBe('warning');
  });

  it('does not alert when utilization is below threshold', async () => {
    const loop = makeLoopMock({ health: 1.20, utilization: 0.80 });
    const orchestrator = createOrchestratorWithLoop(loop);

    await (orchestrator as any).checkKaminoLoopHealth();

    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it('does not alert and does not crash when utilization lookup returns null', async () => {
    const loop = makeLoopMock({ health: 1.20, utilization: null });
    const orchestrator = createOrchestratorWithLoop(loop);

    await (orchestrator as any).checkKaminoLoopHealth();

    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it('suppresses repeat warnings within the cooldown window', async () => {
    const loop = makeLoopMock({ health: 1.20, utilization: 0.96 });
    const orchestrator = createOrchestratorWithLoop(loop);

    await (orchestrator as any).checkKaminoLoopHealth();
    await (orchestrator as any).checkKaminoLoopHealth();

    expect(loop.getSupplyUtilization).toHaveBeenCalledTimes(2);
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
  });

  it('re-alerts once the cooldown window has elapsed', async () => {
    const loop = makeLoopMock({ health: 1.20, utilization: 0.96 });
    const orchestrator = createOrchestratorWithLoop(loop);

    await (orchestrator as any).checkKaminoLoopHealth();
    // Simulate time passing beyond the 30-minute cooldown.
    (orchestrator as any).lastKaminoLoopUtilizationWarnAt = Date.now() - 31 * 60 * 1000;
    await (orchestrator as any).checkKaminoLoopHealth();

    expect(mocks.sendAlert).toHaveBeenCalledTimes(2);
  });

  it('still checks utilization even when health rate is in warning range', async () => {
    const loop = makeLoopMock({ health: 1.08, utilization: 0.97 });
    const orchestrator = createOrchestratorWithLoop(loop);

    await (orchestrator as any).checkKaminoLoopHealth();

    // Expect two alerts: one for health warning, one for utilization warning.
    expect(mocks.sendAlert).toHaveBeenCalledTimes(2);
    const messages = mocks.sendAlert.mock.calls.map((c: any[]) => c[0]);
    expect(messages.some((m: string) => m.includes('health WARNING'))).toBe(true);
    expect(messages.some((m: string) => m.includes('utilization'))).toBe(true);
  });
});
