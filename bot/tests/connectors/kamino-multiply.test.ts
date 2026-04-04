import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { calculateDailyCapRemaining } from '../../src/connectors/defi/kamino-multiply.js';

describe('calculateDailyCapRemaining', () => {
  it('subtracts current net flow from configured capacity', () => {
    const remaining = calculateDailyCapRemaining(
      new Decimal('5000000000000000'),
      new Decimal('1250000000000'),
      9,
    );

    expect(remaining).toBe(4_998_750);
  });

  it('treats negative current flow as extra headroom', () => {
    const remaining = calculateDailyCapRemaining(
      new Decimal('5000000000000000'),
      new Decimal('-4015689984736'),
      9,
    );

    expect(remaining).toBeCloseTo(5_004_015.689984736, 9);
  });
});
