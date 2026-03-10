import { BotState, ActionType, Action } from '../types.js';
import type { VaultConfig } from '../types.js';

export interface StateSignals {
  currentState: BotState;
  avgFrAnnualized: number;
  latestFrAnnualized: number;
  daysAboveEntry: number;
  daysBelowExit: number;
  riskApproved: boolean;
  forceState?: BotState;
  dnOperationInProgress: boolean;
  totalNavUsdc: number;
}

export interface StateResult {
  nextState: BotState;
  actions: Action[];
  reason: string;
}

/**
 * Pure state machine — no side effects, no I/O.
 * Given the current signals and config, returns the next state + actions.
 */
export function evaluateState(signals: StateSignals, config: VaultConfig): StateResult {
  const now = Date.now();
  const {
    currentState,
    avgFrAnnualized,
    latestFrAnnualized,
    daysAboveEntry,
    daysBelowExit,
    riskApproved,
    forceState,
    dnOperationInProgress,
  } = signals;

  const {
    frEntryAnnualized,
    frEntryConfirmationDays,
    frExitAnnualized,
    frExitConfirmationDays,
    frEmergencyAnnualized,
    dnAllocationMax,
  } = config.thresholds;

  const usdcAmount = Math.min(
    signals.totalNavUsdc * dnAllocationMax,
    config.risk.maxPositionCapUsd,
  );

  // --- Manual override ---
  if (forceState !== undefined && forceState !== currentState) {
    const action: Action =
      forceState === BotState.BASE_DN
        ? { type: ActionType.DN_ENTRY, params: { forced: true, usdcAmount }, timestamp: now }
        : { type: ActionType.DN_EXIT, params: { forced: true }, timestamp: now };

    return {
      nextState: forceState,
      actions: [action],
      reason: `Manual override: force state to ${forceState}`,
    };
  }

  // --- Emergency exit (any state with DN exposure) ---
  if (currentState === BotState.BASE_DN && latestFrAnnualized < frEmergencyAnnualized) {
    return {
      nextState: BotState.BASE_ONLY,
      actions: [
        {
          type: ActionType.EMERGENCY_EXIT,
          params: {
            latestFrAnnualized,
            emergencyThreshold: frEmergencyAnnualized,
          },
          timestamp: now,
        },
      ],
      reason: `Emergency exit: latest FR ${latestFrAnnualized.toFixed(2)}% < emergency threshold ${frEmergencyAnnualized}%`,
    };
  }

  // --- State-specific transitions ---
  switch (currentState) {
    case BotState.BASE_ONLY: {
      // Check entry into DN
      if (dnOperationInProgress) {
        return hold(currentState, 'DN operation already in progress, holding BASE_ONLY');
      }
      if (!riskApproved) {
        return hold(currentState, 'Risk manager has not approved DN entry');
      }
      if (avgFrAnnualized > frEntryAnnualized && daysAboveEntry >= frEntryConfirmationDays) {
        return {
          nextState: BotState.BASE_DN,
          actions: [
            {
              type: ActionType.DN_ENTRY,
              params: {
                avgFrAnnualized,
                daysAboveEntry,
                entryThreshold: frEntryAnnualized,
                confirmationDays: frEntryConfirmationDays,
                usdcAmount,
              },
              timestamp: now,
            },
          ],
          reason: `FR entry: avg FR ${avgFrAnnualized.toFixed(2)}% > ${frEntryAnnualized}% for ${daysAboveEntry} days (need ${frEntryConfirmationDays})`,
        };
      }
      return hold(
        currentState,
        `Holding BASE_ONLY: avg FR ${avgFrAnnualized.toFixed(2)}% (threshold ${frEntryAnnualized}%), days above ${daysAboveEntry}/${frEntryConfirmationDays}`,
      );
    }

    case BotState.BASE_DN: {
      // Check exit from DN
      if (dnOperationInProgress) {
        return hold(currentState, 'DN operation already in progress, holding BASE_DN');
      }
      if (daysBelowExit >= frExitConfirmationDays) {
        return {
          nextState: BotState.BASE_ONLY,
          actions: [
            {
              type: ActionType.DN_EXIT,
              params: {
                daysBelowExit,
                exitThreshold: frExitAnnualized,
                confirmationDays: frExitConfirmationDays,
              },
              timestamp: now,
            },
          ],
          reason: `FR exit: days below exit threshold ${daysBelowExit} >= ${frExitConfirmationDays}`,
        };
      }
      return hold(
        currentState,
        `Holding BASE_DN: days below exit ${daysBelowExit}/${frExitConfirmationDays}, latest FR ${latestFrAnnualized.toFixed(2)}%`,
      );
    }

    default:
      return hold(currentState, `Unknown state ${currentState as string}, no action`);
  }
}

function hold(state: BotState, reason: string): StateResult {
  return { nextState: state, actions: [], reason };
}
