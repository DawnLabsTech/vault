import { describe, expect, it } from 'vitest';
import { evaluateSwitchEconomics } from '../../src/core/switch-economics.js';

describe('evaluateSwitchEconomics', () => {
  it('approves a switch when expected gain over the payback window exceeds cost', () => {
    const result = evaluateSwitchEconomics({
      deployableAmountUsd: 10_000,
      apyDiff: 0.15,
      paybackWindowDays: 7,
      estimatedSwitchCostBps: 10,
      estimatedSwitchCostUsd: 2,
      minNetGainUsd: 0,
    });

    expect(result.expectedGainUsd).toBeCloseTo(28.767123, 4);
    expect(result.estimatedSwitchCostUsd).toBeCloseTo(12, 6);
    expect(result.netExpectedGainUsd).toBeCloseTo(16.767123, 4);
    expect(result.shouldSwitch).toBe(true);
  });

  it('rejects a switch when expected gain does not repay switch cost', () => {
    const result = evaluateSwitchEconomics({
      deployableAmountUsd: 10_000,
      apyDiff: 0.03,
      paybackWindowDays: 7,
      estimatedSwitchCostBps: 10,
      estimatedSwitchCostUsd: 2,
      minNetGainUsd: 0,
    });

    expect(result.expectedGainUsd).toBeCloseTo(5.753425, 4);
    expect(result.estimatedSwitchCostUsd).toBeCloseTo(12, 6);
    expect(result.netExpectedGainUsd).toBeCloseTo(-6.246575, 4);
    expect(result.shouldSwitch).toBe(false);
  });

  it('supports an explicit minimum net gain buffer', () => {
    const result = evaluateSwitchEconomics({
      deployableAmountUsd: 10_000,
      apyDiff: 0.15,
      paybackWindowDays: 7,
      estimatedSwitchCostBps: 10,
      estimatedSwitchCostUsd: 2,
      minNetGainUsd: 20,
    });

    expect(result.netExpectedGainUsd).toBeCloseTo(16.767123, 4);
    expect(result.shouldSwitch).toBe(false);
  });
});
