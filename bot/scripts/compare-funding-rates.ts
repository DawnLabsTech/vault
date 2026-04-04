/**
 * Compare SOL funding rates: Hyperliquid vs Binance
 *
 * Hyperliquid: 1h funding rate
 * Binance: 8h funding rate
 *
 * Usage: npx tsx scripts/compare-funding-rates.ts
 */

interface HyperliquidFundingEntry {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

interface BinanceFundingEntry {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
  markPrice: string;
}

interface DailyRate {
  date: string;
  hyperliquidAnnualized: number | null;
  binanceAnnualized: number | null;
}

async function fetchHyperliquidFundingRates(days: number): Promise<HyperliquidFundingEntry[]> {
  const startTime = Date.now() - days * 24 * 60 * 60 * 1000;
  const allRates: HyperliquidFundingEntry[] = [];
  let currentStart = startTime;

  // Hyperliquid API returns max 500 entries per request, paginate
  while (currentStart < Date.now()) {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'fundingHistory',
        coin: 'SOL',
        startTime: currentStart,
      }),
    });
    if (!res.ok) throw new Error(`Hyperliquid API error: ${res.status} ${await res.text()}`);
    const batch = (await res.json()) as HyperliquidFundingEntry[];
    if (batch.length === 0) break;
    allRates.push(...batch);
    // Move past last entry
    currentStart = batch[batch.length - 1].time + 1;
    if (batch.length < 500) break;
  }

  return allRates;
}

async function fetchBinanceFundingRates(days: number): Promise<BinanceFundingEntry[]> {
  // Binance /fapi/v1/fundingRate has limit=1000 max
  // 8h intervals = 3 per day, so 1000 entries = ~333 days
  const startTime = Date.now() - days * 24 * 60 * 60 * 1000;
  const allRates: BinanceFundingEntry[] = [];
  let currentStart = startTime;

  while (currentStart < Date.now()) {
    const url = new URL('https://fapi.binance.com/fapi/v1/fundingRate');
    url.searchParams.set('symbol', 'SOLUSDT');
    url.searchParams.set('startTime', String(currentStart));
    url.searchParams.set('limit', '1000');

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Binance API error: ${res.status} ${await res.text()}`);
    const batch = (await res.json()) as BinanceFundingEntry[];
    if (batch.length === 0) break;
    allRates.push(...batch);
    // Move start past the last entry
    currentStart = batch[batch.length - 1].fundingTime + 1;
    if (batch.length < 1000) break;
  }

  return allRates;
}

function groupByDate<T>(entries: T[], getTime: (e: T) => number): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const e of entries) {
    const date = new Date(getTime(e)).toISOString().slice(0, 10);
    const arr = map.get(date) ?? [];
    arr.push(e);
    map.set(date, arr);
  }
  return map;
}

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function main() {
  const DAYS = 90;
  console.log(`Fetching ${DAYS} days of SOL funding rate data...\n`);

  const [hlRates, bnRates] = await Promise.all([
    fetchHyperliquidFundingRates(DAYS),
    fetchBinanceFundingRates(DAYS),
  ]);

  console.log(`Hyperliquid: ${hlRates.length} entries (1h intervals)`);
  console.log(`Binance:     ${bnRates.length} entries (8h intervals)\n`);

  // Group by date
  const hlByDate = groupByDate(hlRates, (e) => e.time);
  const bnByDate = groupByDate(bnRates, (e) => e.fundingTime);

  // Build daily annualized rates
  const allDates = new Set([...hlByDate.keys(), ...bnByDate.keys()]);
  const dailyRates: DailyRate[] = [...allDates].sort().map((date) => {
    const hlEntries = hlByDate.get(date);
    const bnEntries = bnByDate.get(date);

    // Hyperliquid: 1h FR × 24 × 365 × 100 = annualized %
    const hlAnnualized = hlEntries
      ? avg(hlEntries.map((e) => parseFloat(e.fundingRate))) * 24 * 365 * 100
      : null;

    // Binance: 8h FR × 3 × 365 × 100 = annualized %
    const bnAnnualized = bnEntries
      ? avg(bnEntries.map((e) => parseFloat(e.fundingRate))) * 3 * 365 * 100
      : null;

    return { date, hyperliquidAnnualized: hlAnnualized, binanceAnnualized: bnAnnualized };
  });

  // Print daily table (last 14 days)
  console.log('=== Daily Annualized FR (last 14 days) ===');
  console.log('Date       | Hyperliquid |   Binance  |   Diff');
  console.log('-----------|-------------|------------|--------');
  const recent14 = dailyRates.slice(-14);
  for (const d of recent14) {
    const hl = d.hyperliquidAnnualized !== null ? `${d.hyperliquidAnnualized.toFixed(2)}%`.padStart(10) : '      N/A';
    const bn = d.binanceAnnualized !== null ? `${d.binanceAnnualized.toFixed(2)}%`.padStart(9) : '     N/A';
    const diff =
      d.hyperliquidAnnualized !== null && d.binanceAnnualized !== null
        ? `${(d.hyperliquidAnnualized - d.binanceAnnualized).toFixed(2)}%`.padStart(7)
        : '    N/A';
    console.log(`${d.date} | ${hl} |  ${bn} | ${diff}`);
  }

  // Summary stats
  const validHL = dailyRates.filter((d) => d.hyperliquidAnnualized !== null).map((d) => d.hyperliquidAnnualized!);
  const validBN = dailyRates.filter((d) => d.binanceAnnualized !== null).map((d) => d.binanceAnnualized!);

  const last7HL = dailyRates.slice(-7).filter((d) => d.hyperliquidAnnualized !== null).map((d) => d.hyperliquidAnnualized!);
  const last7BN = dailyRates.slice(-7).filter((d) => d.binanceAnnualized !== null).map((d) => d.binanceAnnualized!);

  const last30HL = dailyRates.slice(-30).filter((d) => d.hyperliquidAnnualized !== null).map((d) => d.hyperliquidAnnualized!);
  const last30BN = dailyRates.slice(-30).filter((d) => d.binanceAnnualized !== null).map((d) => d.binanceAnnualized!);

  console.log('\n=== Summary (Annualized %) ===');
  console.log('Period     | Hyperliquid |   Binance  |   Diff');
  console.log('-----------|-------------|------------|--------');

  const printRow = (label: string, hl: number[], bn: number[]) => {
    const hlAvg = hl.length > 0 ? avg(hl) : NaN;
    const bnAvg = bn.length > 0 ? avg(bn) : NaN;
    const hlStr = isNaN(hlAvg) ? '      N/A' : `${hlAvg.toFixed(2)}%`.padStart(10);
    const bnStr = isNaN(bnAvg) ? '     N/A' : `${bnAvg.toFixed(2)}%`.padStart(9);
    const diffStr =
      !isNaN(hlAvg) && !isNaN(bnAvg)
        ? `${(hlAvg - bnAvg).toFixed(2)}%`.padStart(7)
        : '    N/A';
    console.log(`${label.padEnd(10)} | ${hlStr} |  ${bnStr} | ${diffStr}`);
  };

  printRow('7d avg', last7HL, last7BN);
  printRow('30d avg', last30HL, last30BN);
  printRow('90d avg', validHL, validBN);

  // Go/No-Go decision
  const hlOverall = validHL.length > 0 ? avg(validHL) : 0;
  const bnOverall = validBN.length > 0 ? avg(validBN) : 0;
  const THRESHOLD = 5;

  console.log('\n=== Go/No-Go Decision ===');
  console.log(`Hyperliquid 90d average: ${hlOverall.toFixed(2)}%`);
  console.log(`Binance 90d average:     ${bnOverall.toFixed(2)}%`);

  if (hlOverall >= THRESHOLD) {
    console.log(`\n✅ GO: Hyperliquid SOL FR (${hlOverall.toFixed(2)}%) >= ${THRESHOLD}% threshold`);
    console.log('Phase 2以降の実装を進めてOK');
  } else {
    console.log(`\n❌ NO-GO: Hyperliquid SOL FR (${hlOverall.toFixed(2)}%) < ${THRESHOLD}% threshold`);
    console.log('統合見送り');
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
