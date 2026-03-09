import type {
  Action,
  PortfolioSnapshot,
  VaultConfig,
} from '../types.js';
import { ActionType, BotState } from '../types.js';
import { createChildLogger } from '../utils/logger.js';
import { round } from '../utils/math.js';
import {
  checkDailyLossLimit,
  checkKillSwitch,
  checkMaxPositionCap,
  checkMaxTransferSize,
  checkPositionDivergence,
} from './guardrails.js';

const log = createChildLogger('risk-manager');

// ── Alert type ─────────────────────────────────────────────────────────────

export interface Alert {
  level: 'warning' | 'critical';
  message: string;
  timestamp: string;
}

// ── Risk Manager ───────────────────────────────────────────────────────────

export class RiskManager {
  private config: VaultConfig;
  private dayStartNav: number;

  constructor(config: VaultConfig, dayStartNav: number = 0) {
    this.config = config;
    this.dayStartNav = dayStartNav;
  }

  /** Update the day-start NAV (called at daily reset time) */
  setDayStartNav(nav: number): void {
    this.dayStartNav = nav;
    log.info({ dayStartNav: nav }, 'Day-start NAV updated');
  }

  /**
   * Pre-trade check: validate an action before execution.
   * Returns whether the action is approved and the reason if not.
   */
  preTradeCheck(
    action: Action,
    portfolio: PortfolioSnapshot,
  ): { approved: boolean; reason: string } {
    // Kill switch overrides everything
    if (checkKillSwitch()) {
      return {
        approved: false,
        reason: 'Kill switch is active — all trading halted',
      };
    }

    // Daily loss limit
    const lossCheck = checkDailyLossLimit(
      portfolio.totalNavUsdc,
      this.dayStartNav,
      this.config.risk.dailyLossLimitPct,
    );
    if (!lossCheck.ok) {
      return {
        approved: false,
        reason: `Daily loss limit breached (${lossCheck.lossPct}% loss >= ${this.config.risk.dailyLossLimitPct}% limit). Only EMERGENCY_EXIT allowed.`,
      };
    }

    // Action-specific checks
    switch (action.type) {
      case ActionType.DN_ENTRY: {
        const usdcAmount = (action.params.usdcAmount as number) ?? 0;

        // Position cap check
        const capCheck = checkMaxPositionCap(
          usdcAmount,
          this.config.risk.maxPositionCapUsd,
          portfolio.totalNavUsdc,
          this.config.thresholds.dnAllocationMax,
        );
        if (!capCheck.ok) {
          return {
            approved: false,
            reason: `DN entry amount ${usdcAmount} exceeds position cap. Allowed: ${capCheck.allowedSize}`,
          };
        }

        // Transfer size check
        const transferCheck = checkMaxTransferSize(
          usdcAmount,
          this.config.risk.maxTransferSizeUsd,
        );
        if (!transferCheck.ok) {
          log.warn(
            { amount: usdcAmount, splits: transferCheck.splitAmounts.length },
            'DN entry will require split transfers',
          );
          // This is a warning, not a block — the executor should handle splitting
        }

        return { approved: true, reason: '' };
      }

      case ActionType.DN_EXIT: {
        // Always allow exit (de-risking)
        return { approved: true, reason: '' };
      }

      case ActionType.EMERGENCY_EXIT: {
        // Always allow emergency exit
        return { approved: true, reason: '' };
      }

      case ActionType.REBALANCE_LENDING: {
        // Lending rebalance is low-risk, always allowed unless kill switch
        return { approved: true, reason: '' };
      }

      default: {
        return {
          approved: false,
          reason: `Unknown action type: ${action.type}`,
        };
      }
    }
  }

  /**
   * Continuous monitoring: check portfolio health and return alerts/actions.
   * Called on each tick.
   */
  continuousMonitor(portfolio: PortfolioSnapshot): {
    alerts: Alert[];
    actions: Action[];
  } {
    const alerts: Alert[] = [];
    const actions: Action[] = [];
    const now = new Date().toISOString();

    // 1. Kill switch
    if (checkKillSwitch()) {
      alerts.push({
        level: 'critical',
        message: 'Kill switch activated — initiating emergency exit',
        timestamp: now,
      });
      actions.push({
        type: ActionType.EMERGENCY_EXIT,
        params: { trigger: 'kill_switch' },
        timestamp: Date.now(),
      });
      return { alerts, actions };
    }

    // 2. Daily loss limit
    const lossCheck = checkDailyLossLimit(
      portfolio.totalNavUsdc,
      this.dayStartNav,
      this.config.risk.dailyLossLimitPct,
    );
    if (!lossCheck.ok) {
      alerts.push({
        level: 'critical',
        message: `Daily loss limit breached: ${lossCheck.lossPct}% (limit: ${this.config.risk.dailyLossLimitPct}%)`,
        timestamp: now,
      });
      // If in DN position, trigger emergency exit
      if (portfolio.state === BotState.BASE_DN) {
        actions.push({
          type: ActionType.EMERGENCY_EXIT,
          params: { trigger: 'daily_loss_limit', lossPct: lossCheck.lossPct },
          timestamp: Date.now(),
        });
      }
    } else if (lossCheck.lossPct > this.config.risk.dailyLossLimitPct * 0.7) {
      // Warn at 70% of the limit
      alerts.push({
        level: 'warning',
        message: `Approaching daily loss limit: ${lossCheck.lossPct}% (limit: ${this.config.risk.dailyLossLimitPct}%)`,
        timestamp: now,
      });
    }

    // 3. Position divergence (only relevant in BASE_DN state)
    if (portfolio.state === BotState.BASE_DN) {
      // dawnSOL value in SOL terms (approximate via price ratio)
      const spotSolEquivalent =
        portfolio.dawnsolPrice > 0 && portfolio.solPrice > 0
          ? (portfolio.dawnsolBalance * portfolio.dawnsolPrice) /
            portfolio.solPrice
          : 0;
      const shortSol = Math.abs(portfolio.binancePerpSize);

      const divCheck = checkPositionDivergence(
        spotSolEquivalent,
        shortSol,
        this.config.risk.positionDivergenceThresholdPct,
      );

      if (!divCheck.ok) {
        alerts.push({
          level: 'warning',
          message: `Position divergence: ${divCheck.divergencePct}% (spot: ${round(spotSolEquivalent, 4)} SOL, short: ${round(shortSol, 4)} SOL, threshold: ${this.config.risk.positionDivergenceThresholdPct}%)`,
          timestamp: now,
        });
      }
    }

    if (alerts.length > 0) {
      log.warn(
        { alertCount: alerts.length, actionCount: actions.length },
        'Risk alerts generated',
      );
    }

    return { alerts, actions };
  }
}
