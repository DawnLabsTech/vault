import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProtocolCircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from '../../src/risk/protocol-circuit-breaker.js';
import type { LendingProtocol } from '../../src/types.js';

// Mock sendAlert
vi.mock('../../src/utils/notify.js', () => ({
  sendAlert: vi.fn(),
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeMockProtocol(name: string, balance: number = 1000): LendingProtocol {
  return {
    name,
    getApy: vi.fn(async () => 0.05),
    getBalance: vi.fn(async () => balance),
    deposit: vi.fn(async () => 'mock-tx'),
    withdraw: vi.fn(async () => 'mock-tx'),
  };
}

describe('ProtocolCircuitBreaker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { price: '1.0000' },
        },
      }),
    });
  });

  it('initializes with all protocols enabled', () => {
    const protocols = [makeMockProtocol('kamino'), makeMockProtocol('jupiter')];
    const cb = new ProtocolCircuitBreaker(protocols);

    expect(cb.getDisabledProtocols()).toEqual([]);
    expect(cb.isDisabled('kamino')).toBe(false);
    expect(cb.isDisabled('jupiter')).toBe(false);
  });

  it('returns no events when all protocols are healthy', async () => {
    const protocols = [makeMockProtocol('kamino')];
    const cb = new ProtocolCircuitBreaker(protocols);

    const events = await cb.check();
    // Only oracle check runs (TVL needs 2+ data points)
    expect(events.filter((e) => e.severity === 'critical')).toEqual([]);
  });

  it('trips protocol after consecutive balance check failures', async () => {
    const failProtocol: LendingProtocol = {
      name: 'broken',
      getApy: vi.fn(async () => 0.05),
      getBalance: vi.fn(async () => {
        throw new Error('RPC timeout');
      }),
      deposit: vi.fn(async () => ''),
      withdraw: vi.fn(async () => ''),
    };

    const onTrip = vi.fn();
    const cb = new ProtocolCircuitBreaker([failProtocol], {
      maxConsecutiveFailures: 3,
    });
    cb.onTrip = onTrip;

    // Need 3 consecutive failures
    await cb.check(); // failure 1
    expect(cb.isDisabled('broken')).toBe(false);
    await cb.check(); // failure 2
    expect(cb.isDisabled('broken')).toBe(false);
    await cb.check(); // failure 3 — trips
    expect(cb.isDisabled('broken')).toBe(true);
    expect(onTrip).toHaveBeenCalledWith('broken', expect.stringContaining('consecutive'));
  });

  it('resets failure count on successful check', async () => {
    let shouldFail = true;
    const protocol: LendingProtocol = {
      name: 'flaky',
      getApy: vi.fn(async () => 0.05),
      getBalance: vi.fn(async () => {
        if (shouldFail) throw new Error('fail');
        return 1000;
      }),
      deposit: vi.fn(async () => ''),
      withdraw: vi.fn(async () => ''),
    };

    const cb = new ProtocolCircuitBreaker([protocol], {
      maxConsecutiveFailures: 3,
    });

    await cb.check(); // failure 1
    await cb.check(); // failure 2
    shouldFail = false;
    await cb.check(); // success — resets counter
    shouldFail = true;
    await cb.check(); // failure 1 (reset)
    await cb.check(); // failure 2
    expect(cb.isDisabled('flaky')).toBe(false); // not yet 3 consecutive
  });

  it('detects USDC oracle deviation warning', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { price: '0.9940' },
        },
      }),
    });

    const protocols = [makeMockProtocol('kamino')];
    const cb = new ProtocolCircuitBreaker(protocols, {
      oracleDeviationBps: 50,
      oracleDeviationCriticalBps: 100,
    });

    const events = await cb.check();
    const oracleEvent = events.find((e) => e.protocol === '*' && e.severity === 'warning');
    expect(oracleEvent).toBeDefined();
    expect(oracleEvent!.reason).toContain('oracle warning');
  });

  it('trips all protocols on critical USDC deviation', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { price: '0.9850' },
        },
      }),
    });

    const onTrip = vi.fn();
    const protocols = [makeMockProtocol('kamino'), makeMockProtocol('jupiter')];
    const cb = new ProtocolCircuitBreaker(protocols, {
      oracleDeviationBps: 50,
      oracleDeviationCriticalBps: 100,
    });
    cb.onTrip = onTrip;

    await cb.check();
    expect(cb.isDisabled('kamino')).toBe(true);
    expect(cb.isDisabled('jupiter')).toBe(true);
    expect(onTrip).toHaveBeenCalledTimes(2);
  });

  it('manually enables/disables protocols', () => {
    const protocols = [makeMockProtocol('kamino')];
    const cb = new ProtocolCircuitBreaker(protocols);

    cb.disableProtocol('kamino', 'manual');
    expect(cb.isDisabled('kamino')).toBe(true);

    cb.enableProtocol('kamino');
    expect(cb.isDisabled('kamino')).toBe(false);
  });

  it('provides health summary', async () => {
    const protocols = [makeMockProtocol('kamino'), makeMockProtocol('jupiter')];
    const cb = new ProtocolCircuitBreaker(protocols);

    await cb.check();

    const summary = cb.getHealthSummary();
    expect(summary['kamino']).toBeDefined();
    expect(summary['kamino']!.circuitOpen).toBe(false);
    expect(summary['jupiter']).toBeDefined();
  });

  it('skips disabled protocols and checks cooldown', async () => {
    const protocols = [makeMockProtocol('kamino')];
    const cb = new ProtocolCircuitBreaker(protocols, {
      cooldownMs: 100, // very short for testing
    });

    cb.disableProtocol('kamino', 'test');
    expect(cb.isDisabled('kamino')).toBe(true);

    // Simulate time passing beyond cooldown
    const state = (cb as any).healthStates.get('kamino')!;
    state.circuitOpenedAt = Date.now() - 200; // past cooldown

    await cb.check();
    expect(cb.isDisabled('kamino')).toBe(false);
  });
});
