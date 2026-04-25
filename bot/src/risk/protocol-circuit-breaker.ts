/**
 * Protocol Circuit Breaker — detects anomalies in lending protocols
 * and triggers emergency withdrawal before funds are lost.
 *
 * Monitors:
 *  - TVL drops (sudden outflows signal hacks or panics)
 *  - Withdrawal failures (protocol may be frozen)
 *
 * Oracle anomaly detection lives in `oracle-monitor.ts` and routes to
 * `tripProtocol()` via the orchestrator when sustained.
 *
 * Integration: registered in orchestrator as a 60s scheduled task.
 * When tripped, emits a withdrawal action and disables the protocol.
 */
import { createChildLogger } from '../utils/logger.js';
import { sendAlert } from '../utils/notify.js';
import type { LendingProtocol, CircuitBreakerConfig } from '../types.js';

const log = createChildLogger('circuit-breaker');

const KAMINO_API = 'https://api.kamino.finance';
const KAMINO_MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  checkIntervalMs: 60_000,
  tvlDropThresholdPct: 20,
  tvlDropWindowMs: 3_600_000,
  maxConsecutiveFailures: 3,
  cooldownMs: 86_400_000,
};

export interface ProtocolHealthState {
  name: string;
  tvlHistory: Array<{ tvl: number; ts: number }>;
  consecutiveFailures: number;
  circuitOpen: boolean;
  circuitOpenedAt: number;
  lastCheckAt: number;
}

export interface CircuitBreakerEvent {
  protocol: string;
  reason: string;
  severity: 'warning' | 'critical';
  timestamp: number;
  data?: Record<string, unknown>;
}

export class ProtocolCircuitBreaker {
  private config: CircuitBreakerConfig;
  private protocols: Map<string, LendingProtocol>;
  private healthStates: Map<string, ProtocolHealthState> = new Map();
  private disabledProtocols: Set<string> = new Set();

  /** Callback when a protocol is tripped — orchestrator wires this to withdrawal */
  onTrip?: (protocolName: string, reason: string) => Promise<void>;

  constructor(
    protocols: LendingProtocol[],
    config?: Partial<CircuitBreakerConfig>,
  ) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
    this.protocols = new Map(protocols.map((p) => [p.name, p]));

    for (const p of protocols) {
      this.healthStates.set(p.name, {
        name: p.name,
        tvlHistory: [],
        consecutiveFailures: 0,
        circuitOpen: false,
        circuitOpenedAt: 0,
        lastCheckAt: 0,
      });
    }
  }

  /** Run a single check cycle across all active protocols */
  async check(): Promise<CircuitBreakerEvent[]> {
    const events: CircuitBreakerEvent[] = [];
    const now = Date.now();

    for (const [name, protocol] of this.protocols) {
      if (this.disabledProtocols.has(name)) {
        // Check cooldown for re-enabling
        const state = this.healthStates.get(name)!;
        if (state.circuitOpen && now - state.circuitOpenedAt > this.config.cooldownMs) {
          log.info({ protocol: name }, 'Cooldown expired, re-enabling protocol for monitoring');
          state.circuitOpen = false;
          state.consecutiveFailures = 0;
          this.disabledProtocols.delete(name);
        }
        continue;
      }

      const state = this.healthStates.get(name)!;

      // 1. TVL check
      const tvlEvent = await this.checkTvl(name, state, now);
      if (tvlEvent) events.push(tvlEvent);

      // 2. Withdrawal health check (try getBalance as a proxy)
      const failEvent = await this.checkWithdrawalHealth(name, protocol, state, now);
      if (failEvent) events.push(failEvent);

      state.lastCheckAt = now;
    }

    return events;
  }

  private async checkTvl(
    name: string,
    state: ProtocolHealthState,
    now: number,
  ): Promise<CircuitBreakerEvent | null> {
    try {
      const tvl = await this.fetchProtocolTvl(name);
      if (tvl === null) return null;

      state.tvlHistory.push({ tvl, ts: now });
      // Keep only entries within the window
      const cutoff = now - this.config.tvlDropWindowMs;
      state.tvlHistory = state.tvlHistory.filter((e) => e.ts >= cutoff);

      if (state.tvlHistory.length < 2) return null;

      const oldest = state.tvlHistory[0]!;
      const dropPct = ((oldest.tvl - tvl) / oldest.tvl) * 100;

      if (dropPct >= this.config.tvlDropThresholdPct) {
        const reason = `TVL dropped ${dropPct.toFixed(1)}% in ${((now - oldest.ts) / 60_000).toFixed(0)}min (${(oldest.tvl / 1e6).toFixed(1)}M → ${(tvl / 1e6).toFixed(1)}M)`;
        log.error({ protocol: name, dropPct, oldTvl: oldest.tvl, newTvl: tvl }, reason);

        await this.tripProtocol(name, reason);

        return {
          protocol: name,
          reason,
          severity: 'critical',
          timestamp: now,
          data: { dropPct, oldTvl: oldest.tvl, newTvl: tvl },
        };
      }
    } catch (err) {
      log.warn({ protocol: name, error: (err as Error).message }, 'TVL check failed');
    }

    return null;
  }

  private async checkWithdrawalHealth(
    name: string,
    protocol: LendingProtocol,
    state: ProtocolHealthState,
    now: number,
  ): Promise<CircuitBreakerEvent | null> {
    try {
      await protocol.getBalance();
      state.consecutiveFailures = 0;
    } catch (err) {
      state.consecutiveFailures++;
      log.warn(
        { protocol: name, failures: state.consecutiveFailures, error: (err as Error).message },
        'Protocol balance check failed',
      );

      if (state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        const reason = `${state.consecutiveFailures} consecutive balance check failures`;
        await this.tripProtocol(name, reason);

        return {
          protocol: name,
          reason,
          severity: 'critical',
          timestamp: now,
          data: { consecutiveFailures: state.consecutiveFailures },
        };
      }
    }

    return null;
  }

  /**
   * Public trip — used by external monitors (oracle-monitor) to disable a
   * protocol or all protocols when sustained anomalies fire. Routes through
   * the same code path as TVL/withdrawal-failure trips so the action,
   * cooldown, and onTrip callback are identical.
   */
  async trip(name: string, reason: string): Promise<void> {
    if (name === '*') {
      for (const protoName of this.protocols.keys()) {
        if (!this.disabledProtocols.has(protoName)) {
          await this.tripProtocol(protoName, reason);
        }
      }
      return;
    }
    if (this.protocols.has(name) && !this.disabledProtocols.has(name)) {
      await this.tripProtocol(name, reason);
    }
  }

  private async tripProtocol(name: string, reason: string): Promise<void> {
    const state = this.healthStates.get(name);
    if (!state) return;

    state.circuitOpen = true;
    state.circuitOpenedAt = Date.now();
    this.disabledProtocols.add(name);

    log.error({ protocol: name, reason }, 'CIRCUIT BREAKER TRIPPED');
    await sendAlert(`Circuit breaker tripped for ${name}: ${reason}`, 'critical');

    if (this.onTrip) {
      try {
        await this.onTrip(name, reason);
      } catch (err) {
        log.error({ protocol: name, error: (err as Error).message }, 'Emergency withdrawal failed');
        await sendAlert(`Emergency withdrawal from ${name} FAILED: ${(err as Error).message}`, 'critical');
      }
    }
  }

  private async fetchProtocolTvl(name: string): Promise<number | null> {
    try {
      switch (name) {
        case 'kamino': {
          const res = await fetch(`${KAMINO_API}/kamino-market/${KAMINO_MAIN_MARKET}/metrics`);
          if (!res.ok) return null;
          const data = (await res.json()) as any;
          return data.tvl ?? data.totalValueLocked ?? null;
        }
        case 'jupiter': {
          // Jupiter Lend doesn't expose a simple TVL endpoint;
          // use total supply from their earn API as a proxy
          const res = await fetch('https://api.jup.ag/lend/v1/earn/tokens');
          if (!res.ok) return null;
          const data = (await res.json()) as any;
          const usdcToken = data?.tokens?.find(
            (t: any) => t.mint === USDC_MINT || t.symbol === 'USDC',
          );
          return usdcToken?.totalDeposits ?? usdcToken?.tvl ?? null;
        }
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  /** Get current disabled protocols */
  getDisabledProtocols(): string[] {
    return [...this.disabledProtocols];
  }

  /** Check if a specific protocol is disabled */
  isDisabled(name: string): boolean {
    return this.disabledProtocols.has(name);
  }

  /** Manually disable a protocol */
  disableProtocol(name: string, reason: string): void {
    this.tripProtocol(name, reason);
  }

  /** Manually re-enable a protocol (operator override) */
  enableProtocol(name: string): void {
    this.disabledProtocols.delete(name);
    const state = this.healthStates.get(name);
    if (state) {
      state.circuitOpen = false;
      state.consecutiveFailures = 0;
    }
    log.info({ protocol: name }, 'Protocol manually re-enabled');
  }

  /** Get health state summary for dashboard/API */
  getHealthSummary(): Record<string, {
    circuitOpen: boolean;
    consecutiveFailures: number;
    lastTvl: number | null;
    lastCheckAt: number;
  }> {
    const summary: Record<string, any> = {};
    for (const [name, state] of this.healthStates) {
      const lastTvl = state.tvlHistory.length > 0
        ? state.tvlHistory[state.tvlHistory.length - 1]!.tvl
        : null;
      summary[name] = {
        circuitOpen: state.circuitOpen,
        consecutiveFailures: state.consecutiveFailures,
        lastTvl,
        lastCheckAt: state.lastCheckAt,
      };
    }
    return summary;
  }
}
