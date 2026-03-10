/** Fee model for backtest simulation */

export interface FeeParams {
  swapSlippagePct: number;    // 0.001 = 0.1%
  binanceTakerPct: number;    // 0.0004 = 0.04%
  withdrawFeeUsdc: number;    // flat fee in USDC
  solanaGasSol: number;       // SOL per tx
  txCountEntry: number;       // number of Solana txs for entry
  txCountExit: number;        // number of Solana txs for exit
}

const DEFAULT_FEES: FeeParams = {
  swapSlippagePct: 0.001,     // 0.1%
  binanceTakerPct: 0.0004,    // 0.04%
  withdrawFeeUsdc: 1,
  solanaGasSol: 0.000005,
  txCountEntry: 3,
  txCountExit: 3,
};

/**
 * Calculate total entry cost for DN position.
 * Fees: swap slippage + Binance taker + withdraw fee + Solana gas
 */
export function calcEntryFees(
  usdcAmount: number,
  solPrice: number,
  fees: FeeParams = DEFAULT_FEES,
): number {
  const swapSlippage = usdcAmount * fees.swapSlippagePct;
  const binanceFee = usdcAmount * fees.binanceTakerPct;
  const gasCost = fees.solanaGasSol * fees.txCountEntry * solPrice;
  return swapSlippage + binanceFee + fees.withdrawFeeUsdc + gasCost;
}

/**
 * Calculate total exit cost for DN position.
 * Fees: swap slippage + Binance taker + Solana gas (no withdraw fee on exit)
 */
export function calcExitFees(
  usdcAmount: number,
  solPrice: number,
  fees: FeeParams = DEFAULT_FEES,
): number {
  const swapSlippage = usdcAmount * fees.swapSlippagePct;
  const binanceFee = usdcAmount * fees.binanceTakerPct;
  const gasCost = fees.solanaGasSol * fees.txCountExit * solPrice;
  return swapSlippage + binanceFee + gasCost;
}
