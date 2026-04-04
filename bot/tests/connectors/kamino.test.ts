import { describe, expect, it } from 'vitest';
import { extractKaminoUsdcBalance } from '../../src/connectors/defi/kamino.js';

describe('extractKaminoUsdcBalance', () => {
  it('uses refreshedStats userTotalDeposit when present', () => {
    const data = [
      { refreshedStats: { userTotalDeposit: '17.998396' } },
      { refreshedStats: { userTotalDeposit: '11.159022' } },
    ];

    expect(extractKaminoUsdcBalance(data)).toBeCloseTo(29.157418, 6);
  });

  it('falls back to legacy array deposit shapes', () => {
    const data = [
      {
        deposits: [
          { symbol: 'USDC', amount: 12.34 },
        ],
      },
      {
        supplyPositions: [
          { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', balance: 5.66 },
        ],
      },
      {
        deposits: [
          { symbol: 'USDC', depositedAmount: '2000000' },
        ],
      },
    ];

    expect(extractKaminoUsdcBalance(data)).toBeCloseTo(20, 6);
  });
});
