export interface SwitchEconomicsInput {
  deployableAmountUsd: number;
  apyDiff: number;
  paybackWindowDays: number;
  estimatedSwitchCostBps: number;
  estimatedSwitchCostUsd: number;
  minNetGainUsd: number;
}

export interface SwitchEconomicsResult {
  expectedGainUsd: number;
  estimatedSwitchCostUsd: number;
  netExpectedGainUsd: number;
  shouldSwitch: boolean;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Estimate whether a market switch earns back its cost within the configured payback window.
 */
export function evaluateSwitchEconomics(
  input: SwitchEconomicsInput,
): SwitchEconomicsResult {
  const deployableAmountUsd = Math.max(input.deployableAmountUsd, 0);
  const apyDiff = Math.max(input.apyDiff, 0);
  const paybackWindowDays = Math.max(input.paybackWindowDays, 0);
  const estimatedSwitchCostBps = Math.max(input.estimatedSwitchCostBps, 0);
  const fixedSwitchCostUsd = Math.max(input.estimatedSwitchCostUsd, 0);
  const minNetGainUsd = Math.max(input.minNetGainUsd, 0);

  const expectedGainUsd = round(
    deployableAmountUsd * apyDiff * (paybackWindowDays / 365),
  );
  const variableSwitchCostUsd = round(
    deployableAmountUsd * (estimatedSwitchCostBps / 10_000),
  );
  const estimatedSwitchCostUsd = round(
    variableSwitchCostUsd + fixedSwitchCostUsd,
  );
  const netExpectedGainUsd = round(expectedGainUsd - estimatedSwitchCostUsd);

  return {
    expectedGainUsd,
    estimatedSwitchCostUsd,
    netExpectedGainUsd,
    shouldSwitch: netExpectedGainUsd > minNetGainUsd,
  };
}
