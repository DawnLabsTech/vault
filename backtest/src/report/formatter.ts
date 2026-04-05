import type { BacktestResult, DailySnapshot } from '../types.js';
import { buildSummary } from './metrics.js';

/** Print results as a formatted console table */
export function printTable(result: BacktestResult): void {
  const summary = buildSummary(result);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║          BACKTEST RESULTS                    ║');
  console.log('╠══════════════════════════════════════════════╣');

  for (const [key, value] of Object.entries(summary)) {
    if (key.trim() === '') {
      console.log('╠──────────────────────────────────────────────╣');
    } else {
      const label = key.padEnd(26);
      console.log(`║ ${label} ${String(value).padStart(17)} ║`);
    }
  }

  console.log('╚══════════════════════════════════════════════╝');

  // Print config params
  const c = result.config;
  console.log(`\nParameters: entry=${c.frEntryAnnualized}% exit=${c.frExitAnnualized}% emergency=${c.frEmergencyAnnualized}% confirm=${c.confirmDays}d alloc=${(c.dnAllocation * 100).toFixed(0)}% multiply=${c.multiplyApy}%${isFinite(c.multiplyCapacity) ? ' cap=$' + c.multiplyCapacity.toLocaleString() : ''} lending=${c.lendingApy}% dawnsol=${c.dawnsolApy}%`);
}

/** Output results as CSV */
export function printCsv(result: BacktestResult): void {
  // Summary line
  const s = buildSummary(result);
  console.log('# Summary');
  for (const [key, value] of Object.entries(s)) {
    if (key.trim() !== '') {
      console.log(`${key},${value}`);
    }
  }

  // Daily data
  console.log('\n# Daily Snapshots');
  console.log('date,nav,daily_return,cumulative_return,state,sol_price,funding_rate_8h');
  for (const snap of result.dailySnapshots) {
    console.log(formatSnapshotCsv(snap));
  }
}

/** Output results as JSON */
export function printJson(result: BacktestResult): void {
  console.log(JSON.stringify(result, null, 2));
}

/** Format output based on config */
export function formatOutput(result: BacktestResult, format: 'table' | 'csv' | 'json'): void {
  switch (format) {
    case 'table':
      printTable(result);
      break;
    case 'csv':
      printCsv(result);
      break;
    case 'json':
      printJson(result);
      break;
  }
}

function formatSnapshotCsv(snap: DailySnapshot): string {
  return [
    snap.date,
    snap.nav.toFixed(2),
    snap.dailyReturn.toFixed(6),
    snap.cumulativeReturn.toFixed(6),
    snap.state,
    snap.solPrice.toFixed(2),
    snap.fundingRate8h.toFixed(8),
  ].join(',');
}
