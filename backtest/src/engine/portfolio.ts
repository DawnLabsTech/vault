import { BotState } from '@bot/types.js';
import type { SimPortfolio } from '../types.js';
import { calcEntryFees, calcExitFees } from './fee-model.js';

const HOURS_PER_YEAR = 8760;
const TICK_HOURS = 8;

/** Create initial portfolio in BASE_ONLY state.
 *  Capital starts unallocated; call allocateCapital() to distribute. */
export function createPortfolio(initialCapital: number): SimPortfolio {
  return {
    state: BotState.BASE_ONLY,
    multiplyUsdc: 0,
    lendingUsdc: initialCapital,
    dawnsolAmount: 0,
    shortSolAmount: 0,
    binanceMarginUsdc: 0,
    entryPriceSol: 0,
    totalNavUsdc: initialCapital,
    totalFees: 0,
    totalFundingReceived: 0,
    totalMultiplyYield: 0,
    totalLendingInterest: 0,
    totalStakingYield: 0,
  };
}

/** Accrue Kamino Multiply yield for one 8h tick */
export function accrueMultiplyYield(
  portfolio: SimPortfolio,
  multiplyApy: number,
): void {
  const yieldAmount = portfolio.multiplyUsdc * (multiplyApy / 100) * (TICK_HOURS / HOURS_PER_YEAR);
  portfolio.multiplyUsdc += yieldAmount;
  portfolio.totalMultiplyYield += yieldAmount;
}

/** Allocate idle USDC: Multiply first (up to capacity), overflow to lending */
export function allocateCapital(
  portfolio: SimPortfolio,
  multiplyCapacity: number,
): void {
  const idleUsdc = portfolio.multiplyUsdc + portfolio.lendingUsdc;
  portfolio.multiplyUsdc = Math.min(idleUsdc, multiplyCapacity);
  portfolio.lendingUsdc = Math.max(idleUsdc - portfolio.multiplyUsdc, 0);
}

/** Accrue lending interest for one 8h tick */
export function accrueLendingInterest(
  portfolio: SimPortfolio,
  lendingApy: number,
): void {
  const interest = portfolio.lendingUsdc * (lendingApy / 100) * (TICK_HOURS / HOURS_PER_YEAR);
  portfolio.lendingUsdc += interest;
  portfolio.totalLendingInterest += interest;
}

/** Accrue funding payment for one 8h tick (positive FR = income for shorts) */
export function accrueFunding(
  portfolio: SimPortfolio,
  solPrice: number,
  fundingRate8h: number,
): void {
  const payment = portfolio.shortSolAmount * solPrice * fundingRate8h;
  portfolio.binanceMarginUsdc += payment;
  portfolio.totalFundingReceived += payment;
}

/** Accrue dawnSOL staking yield for one 8h tick */
export function accrueDawnsolYield(
  portfolio: SimPortfolio,
  solPrice: number,
  dawnsolApy: number,
): void {
  // dawnSOL yield accrues as additional SOL
  const yieldSol = portfolio.dawnsolAmount * (dawnsolApy / 100) * (TICK_HOURS / HOURS_PER_YEAR);
  const yieldUsdc = yieldSol * solPrice;
  portfolio.dawnsolAmount += yieldSol;
  portfolio.totalStakingYield += yieldUsdc;
}

/** Enter DN position: split capital between dawnSOL + Binance short.
 *  Pulls from lending first, then Multiply if insufficient. */
export function enterDn(
  portfolio: SimPortfolio,
  solPrice: number,
  dnAllocation: number,
): void {
  const dnUsdc = portfolio.totalNavUsdc * dnAllocation;
  const fees = calcEntryFees(dnUsdc, solPrice);

  // Pull from lending first, then Multiply
  let remaining = dnUsdc;
  const fromLending = Math.min(portfolio.lendingUsdc, remaining);
  portfolio.lendingUsdc -= fromLending;
  remaining -= fromLending;

  if (remaining > 0) {
    const fromMultiply = Math.min(portfolio.multiplyUsdc, remaining);
    portfolio.multiplyUsdc -= fromMultiply;
  }

  // Half goes to dawnSOL (buy SOL → stake), half to Binance margin
  const halfUsdc = (dnUsdc - fees) / 2;
  const solAmount = halfUsdc / solPrice;

  portfolio.dawnsolAmount = solAmount;
  portfolio.shortSolAmount = solAmount;
  portfolio.binanceMarginUsdc = halfUsdc;
  portfolio.entryPriceSol = solPrice;
  portfolio.totalFees += fees;
  portfolio.state = BotState.BASE_DN;
}

/** Exit DN position: close short, unstake dawnSOL, return to lending */
export function exitDn(
  portfolio: SimPortfolio,
  solPrice: number,
): void {
  // Close Binance short: PnL from price movement
  const shortPnl = portfolio.shortSolAmount * (portfolio.entryPriceSol - solPrice);
  const binanceValue = portfolio.binanceMarginUsdc + shortPnl;

  // Sell dawnSOL back to USDC
  const dawnsolValue = portfolio.dawnsolAmount * solPrice;

  const totalRecovered = binanceValue + dawnsolValue;
  const fees = calcExitFees(totalRecovered, solPrice);

  portfolio.lendingUsdc += totalRecovered - fees;
  portfolio.dawnsolAmount = 0;
  portfolio.shortSolAmount = 0;
  portfolio.binanceMarginUsdc = 0;
  portfolio.entryPriceSol = 0;
  portfolio.totalFees += fees;
  portfolio.state = BotState.BASE_ONLY;
}

/** Update NAV based on current prices */
export function updateNav(
  portfolio: SimPortfolio,
  solPrice: number,
): void {
  const dawnsolValue = portfolio.dawnsolAmount * solPrice;

  let binanceValue = portfolio.binanceMarginUsdc;
  if (portfolio.shortSolAmount > 0) {
    // Mark-to-market: short PnL
    const shortPnl = portfolio.shortSolAmount * (portfolio.entryPriceSol - solPrice);
    binanceValue += shortPnl;
  }

  portfolio.totalNavUsdc = portfolio.multiplyUsdc + portfolio.lendingUsdc + dawnsolValue + binanceValue;
}
