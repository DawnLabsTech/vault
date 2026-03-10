import { DataStore } from './data/data-store.js';
import { fetchFundingRates } from './data/fetch-funding-rates.js';
import { fetchSolPrices } from './data/fetch-sol-prices.js';
import { runSimulation } from './engine/simulator.js';
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
    lendingApy: Number(get('--lending-apy', '5')),
    dawnsolApy: Number(get('--dawnsol-apy', '7')),
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
  --lending-apy    Fixed lending APY % (default: 5)
  --dawnsol-apy    Fixed dawnSOL APY % (default: 7)
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
  const store = new DataStore();

  try {
    // Step 1: Fetch data
    console.log('Fetching funding rate data...');
    const frCount = await fetchFundingRates(store, 'SOLUSDT', config.startDate, config.endDate);
    console.log(`  Total FR records fetched: ${frCount}`);

    console.log('Fetching SOL price data...');
    const priceCount = await fetchSolPrices(store, 'SOLUSDT', config.startDate, config.endDate);
    console.log(`  Total price records fetched: ${priceCount}`);

    if (config.fetchOnly) {
      console.log('\nData fetch complete (--fetch-only mode).');
      return;
    }

    // Step 2: Load data for simulation
    const startMs = new Date(config.startDate).getTime();
    const endMs = new Date(config.endDate).getTime();

    const frTicks = store.getFundingRates('SOLUSDT', startMs, endMs);
    const priceTicks = store.getSolPrices(startMs, endMs);

    console.log(`\nRunning simulation with ${frTicks.length} FR ticks and ${priceTicks.length} price ticks...`);

    if (frTicks.length === 0 || priceTicks.length === 0) {
      console.error('Error: No data available for the specified period.');
      process.exit(1);
    }

    // Step 3: Run simulation
    const result = runSimulation(frTicks, priceTicks, config);

    // Step 4: Output results
    formatOutput(result, config.output);
  } finally {
    store.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
