import { getEvents } from './events.js';
import { getSnapshots } from './snapshots.js';
import { getDailyPnlRange, getPerformanceSummary } from './pnl.js';
import { round } from '../utils/math.js';
import type { DailyPnL, LedgerEvent, PortfolioSnapshot } from '../types.js';

function escapeCsvField(value: unknown): string {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvRow(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(',');
}

export function exportDailyPnlCsv(from: string, to: string): string {
  const rows = getDailyPnlRange(from, to);
  const headers = [
    'date', 'starting_nav', 'ending_nav', 'daily_return', 'cumulative_return',
    'realized_pnl', 'unrealized_pnl', 'lending_interest', 'funding_received',
    'funding_paid', 'staking_accrual', 'swap_pnl', 'binance_trading_fee',
    'binance_withdraw_fee', 'solana_gas', 'swap_slippage', 'lending_fee',
    'total_fees', 'nav_high', 'nav_low', 'max_drawdown',
  ];

  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(toCsvRow([
      r.date, r.startingNav, r.endingNav, r.dailyReturn, r.cumulativeReturn,
      r.realizedPnl, r.unrealizedPnl, r.lendingInterest, r.fundingReceived,
      r.fundingPaid, r.stakingAccrual, r.swapPnl, r.binanceTradingFee,
      r.binanceWithdrawFee, r.solanaGas, r.swapSlippage, r.lendingFee,
      r.totalFees, r.navHigh, r.navLow, r.maxDrawdown,
    ]));
  }
  return lines.join('\n');
}

export function exportEventsCsv(from: string, to: string): string {
  const events = getEvents({ from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` });
  const headers = [
    'timestamp', 'event_type', 'amount', 'asset', 'price',
    'tx_hash', 'order_id', 'fee', 'fee_asset', 'source_protocol', 'metadata',
  ];

  const lines = [headers.join(',')];
  for (const e of events) {
    lines.push(toCsvRow([
      e.timestamp, e.eventType, e.amount, e.asset, e.price,
      e.txHash, e.orderId, e.fee, e.feeAsset, e.sourceProtocol,
      e.metadata ? JSON.stringify(e.metadata) : '',
    ]));
  }
  return lines.join('\n');
}

export function exportSnapshotsCsv(from: string, to: string): string {
  const snapshots = getSnapshots({ from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` });
  const headers = [
    'timestamp', 'total_nav_usdc', 'lending_balance', 'lending_breakdown',
    'multiply_balance', 'multiply_breakdown',
    'dawnsol_balance', 'dawnsol_usdc_value', 'binance_usdc_balance',
    'buffer_usdc_balance', 'binance_perp_unrealized_pnl', 'binance_perp_size',
    'state', 'sol_price', 'dawnsol_price',
  ];

  const lines = [headers.join(',')];
  for (const s of snapshots) {
    lines.push(toCsvRow([
      s.timestamp, s.totalNavUsdc, s.lendingBalance,
      JSON.stringify(s.lendingBreakdown),
      s.multiplyBalance, JSON.stringify(s.multiplyBreakdown),
      s.dawnsolBalance, s.dawnsolUsdcValue, s.binanceUsdcBalance,
      s.bufferUsdcBalance, s.binancePerpUnrealizedPnl, s.binancePerpSize, s.state,
      s.solPrice, s.dawnsolPrice,
    ]));
  }
  return lines.join('\n');
}

export function exportAuditJson(): object {
  const summary = getPerformanceSummary();
  const allPnl = getDailyPnlRange('0000-01-01', '9999-12-31');

  if (allPnl.length === 0) {
    return {
      period: { start: null, end: null },
      initial_nav: 0,
      final_nav: 0,
      total_return: 0,
      annualized_return: 0,
      sharpe_ratio: 0,
      max_drawdown: 0,
      revenue_breakdown: {
        lending_interest: 0,
        funding_received: 0,
        staking_accrual: 0,
        swap_pnl: 0,
      },
      cost_breakdown: {
        binance_trading_fee: 0,
        binance_withdraw_fee: 0,
        solana_gas: 0,
        swap_slippage: 0,
        lending_fee: 0,
      },
      daily_returns: [],
    };
  }

  const firstDay = allPnl[0]!;
  const lastDay = allPnl[allPnl.length - 1]!;

  // Aggregate revenue and cost breakdowns
  const revenueBreakdown = {
    lending_interest: 0,
    funding_received: 0,
    staking_accrual: 0,
    swap_pnl: 0,
  };
  const costBreakdown = {
    binance_trading_fee: 0,
    binance_withdraw_fee: 0,
    solana_gas: 0,
    swap_slippage: 0,
    lending_fee: 0,
  };

  for (const day of allPnl) {
    revenueBreakdown.lending_interest += day.lendingInterest;
    revenueBreakdown.funding_received += day.fundingReceived;
    revenueBreakdown.staking_accrual += day.stakingAccrual;
    revenueBreakdown.swap_pnl += day.swapPnl;

    costBreakdown.binance_trading_fee += day.binanceTradingFee;
    costBreakdown.binance_withdraw_fee += day.binanceWithdrawFee;
    costBreakdown.solana_gas += day.solanaGas;
    costBreakdown.swap_slippage += day.swapSlippage;
    costBreakdown.lending_fee += day.lendingFee;
  }

  // Round aggregated values
  for (const key of Object.keys(revenueBreakdown) as (keyof typeof revenueBreakdown)[]) {
    revenueBreakdown[key] = round(revenueBreakdown[key], 4);
  }
  for (const key of Object.keys(costBreakdown) as (keyof typeof costBreakdown)[]) {
    costBreakdown[key] = round(costBreakdown[key], 4);
  }

  return {
    period: {
      start: firstDay.date,
      end: lastDay.date,
    },
    initial_nav: firstDay.startingNav,
    final_nav: lastDay.endingNav,
    total_return: summary.totalReturn,
    annualized_return: summary.annualizedReturn,
    sharpe_ratio: summary.sharpeRatio,
    max_drawdown: summary.maxDrawdown,
    revenue_breakdown: revenueBreakdown,
    cost_breakdown: costBreakdown,
    daily_returns: allPnl.map(d => ({
      date: d.date,
      return: d.dailyReturn,
      nav: d.endingNav,
    })),
  };
}
