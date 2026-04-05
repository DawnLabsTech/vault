import { DataStore } from './data/data-store.js';
import { fetchFundingRates } from './data/fetch-funding-rates.js';
import { fetchSolPrices } from './data/fetch-sol-prices.js';
import { runBacktest } from './runner.js';
import { formatOutput } from './report/formatter.js';
import type { BacktestConfig } from './types.js';

function parseArgs(args: string[]): BacktestConfig {
  const get = (flag: string, defaultVal: string): string => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1]! : defaultVal;
  };

  const has = (flag: string): boolean => args.includes(flag);

  return {
    startDate: get('--start', '2021-01-01'),
    endDate: get('--end', '2026-03-01'),
    initialCapital: Number(get('--capital', '10000')),
    multiplyApy: Number(get('--multiply-apy', '13')),
    multiplyCapacity: Number(get('--multiply-cap', 'Infinity')),
    lendingApy: Number(get('--lending-apy', '5')),
    dawnsolApy: Number(get('--dawnsol-apy', '6.8')),
    frEntryAnnualized: Number(get('--entry-fr', '10')),
    frExitAnnualized: Number(get('--exit-fr', '0')),
    frEmergencyAnnualized: Number(get('--emergency-fr', '-10')),
    confirmDays: Number(get('--confirm-days', '3')),
    dnAllocation: Number(get('--dn-alloc', '0.7')),
    output: get('--output', 'table') as 'table' | 'csv' | 'json',
    fetchOnly: has('--fetch-only'),
  };
}

function printUsage(): void {
  console.log(`
Usage: tsx backtest/src/cli.ts [options]

Options:
  --start          Start date (default: 2021-01-01)
  --end            End date (default: 2026-03-01)
  --capital        Initial capital USDC (default: 10000)
  --multiply-apy   Fixed Multiply APY % (default: 13)
  --multiply-cap   Max USDC in Multiply (default: unlimited)
  --lending-apy    Fixed lending APY % (default: 5)
  --dawnsol-apy    Fixed dawnSOL APY % (default: 6.8)
  --entry-fr       FR entry threshold % (default: 10)
  --exit-fr        FR exit threshold % (default: 0)
  --emergency-fr   Emergency exit threshold % (default: -10)
  --confirm-days   Confirmation days (default: 3)
  --dn-alloc       DN allocation ratio (default: 0.7)
  --output         Output format: table|csv|json (default: table)
  --fetch-only     Fetch data only, skip simulation
  --help           Show this help message
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const config = parseArgs(args);

  // Handle fetch-only mode (needs direct DataStore access)
  if (config.fetchOnly) {
    const store = new DataStore();
    try {
      console.log('Fetching funding rate data...');
      const frCount = await fetchFundingRates(store, 'SOLUSDT', config.startDate, config.endDate);
      console.log(`  Total FR records fetched: ${frCount}`);

      console.log('Fetching SOL price data...');
      const priceCount = await fetchSolPrices(store, 'SOLUSDT', config.startDate, config.endDate);
      console.log(`  Total price records fetched: ${priceCount}`);

      console.log('\nData fetch complete (--fetch-only mode).');
    } finally {
      store.close();
    }
    return;
  }

  console.log('Running backtest...');
  const result = await runBacktest(config);
  formatOutput(result, config.output);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
