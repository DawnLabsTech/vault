/**
 * Calculate effective APY for all Multiply candidates at health rate 1.15.
 * Run: npx tsx scripts/calc-all-multiply-apy.ts
 */
import 'dotenv/config';
import {
  KaminoMarket,
  DEFAULT_RECENT_SLOT_DURATION_MS,
} from '@kamino-finance/klend-sdk';
import { address, createSolanaRpc } from '@solana/kit';
import Decimal from 'decimal.js';
import { getOnycApy, isOnycToken } from '../src/connectors/defi/onre-apy.js';
import { getPrimeApy, isPrimeToken } from '../src/connectors/defi/hastra-apy.js';

const RPC_URL = process.env.HELIUS_RPC_URL!;
const rpc = createSolanaRpc(RPC_URL as any);

const STABLECOINS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',  // USDS
  'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH', // CASH
]);

async function getRewardPrice(mint: string): Promise<number> {
  if (STABLECOINS.has(mint)) return 1;
  try {
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
    if (!res.ok) return 0;
    const data = (await res.json()) as any;
    return parseFloat(data.data?.[mint]?.price ?? '0');
  } catch { return 0; }
}

interface Candidate {
  market: string;
  collToken: string;
  debtToken: string;
  label: string;
  collNativeYield: number;
}

const CANDIDATES: Candidate[] = [
  {
    label: 'ONyc/USDC',
    market: '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8',
    collToken: '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5',
    debtToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    collNativeYield: 0.045,
  },
  {
    label: 'ONyc/USDS',
    market: '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8',
    collToken: '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5',
    debtToken: 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
    collNativeYield: 0.045,
  },
  {
    label: 'PRIME/PYUSD',
    market: 'CqAoLuqWtavaVE8deBjMKe8ZfSt9ghR6Vb8nfsyabyHA',
    collToken: '3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7',
    debtToken: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
    collNativeYield: 0.08,
  },
  {
    label: 'PRIME/CASH',
    market: 'CqAoLuqWtavaVE8deBjMKe8ZfSt9ghR6Vb8nfsyabyHA',
    collToken: '3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7',
    debtToken: 'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH',
    collNativeYield: 0.08,
  },
  {
    label: 'USDG/PYUSD',
    market: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
    collToken: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
    debtToken: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
    collNativeYield: 0,
  },
  {
    label: 'CASH/PYUSD',
    market: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
    collToken: 'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH',
    debtToken: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
    collNativeYield: 0,
  },
];

const TARGET_HEALTH = 1.15;

// Cache loaded markets
const marketCache = new Map<string, KaminoMarket>();

async function loadMarket(marketAddr: string): Promise<KaminoMarket> {
  if (marketCache.has(marketAddr)) return marketCache.get(marketAddr)!;
  const m = await KaminoMarket.load(rpc, address(marketAddr), DEFAULT_RECENT_SLOT_DURATION_MS);
  if (!m) throw new Error(`Failed to load market ${marketAddr}`);
  await m.loadReserves();
  marketCache.set(marketAddr, m);
  return m;
}

async function analyze(c: Candidate) {
  const market = await loadMarket(c.market);

  const slotResult = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const slot = typeof slotResult === 'object' ? (slotResult as any).value ?? slotResult : slotResult;

  const collReserve = market.getReserveByMint(address(c.collToken));
  const debtReserve = market.getReserveByMint(address(c.debtToken));
  if (!collReserve || !debtReserve) return { label: c.label, error: 'Reserve not found' };

  // Base APYs
  const baseSupplyApy = collReserve.totalSupplyAPY(BigInt(slot));
  const baseBorrowApy = debtReserve.totalBorrowAPY(BigInt(slot));

  // Native yield
  let nativeYield = c.collNativeYield;
  let nativeSource = 'config';
  if (isOnycToken(c.collToken)) {
    const r = await getOnycApy(RPC_URL, c.collToken, c.collNativeYield);
    nativeYield = r.apy;
    nativeSource = r.source;
  } else if (isPrimeToken(c.collToken)) {
    const r = await getPrimeApy(c.collNativeYield);
    nativeYield = r.apy;
    nativeSource = r.source;
  }

  // Reward APRs
  let depositRewardApr = 0;
  let borrowRewardApr = 0;
  try {
    const fi = await market.getReserveFarmInfo(address(c.collToken), getRewardPrice as any);
    depositRewardApr = fi.depositingRewards.rewardApr.toNumber();
  } catch {}
  try {
    const fi = await market.getReserveFarmInfo(address(c.debtToken), getRewardPrice as any);
    borrowRewardApr = fi.borrowingRewards.rewardApr.toNumber();
  } catch {}

  // LTV & leverage
  let liquidationLtv = 0;
  let maxLeverage = 0;
  try {
    const ltvInfo = market.getMaxAndLiquidationLtvAndBorrowFactorForPair(
      address(c.collToken), address(c.debtToken),
    );
    liquidationLtv = ltvInfo.liquidationLtv;
    maxLeverage = market.getMaxLeverageForPair(address(c.collToken), address(c.debtToken));
  } catch {}

  // Leverage at target health
  let leverage: number;
  if (liquidationLtv <= 0) {
    leverage = 1;
  } else if (TARGET_HEALTH <= liquidationLtv) {
    leverage = maxLeverage;
  } else {
    leverage = TARGET_HEALTH / (TARGET_HEALTH - liquidationLtv);
    leverage = Math.min(leverage, maxLeverage);
  }

  const totalSupply = baseSupplyApy + nativeYield + depositRewardApr;
  const effectiveBorrow = baseBorrowApy - borrowRewardApr;
  const effectiveApy = leverage * totalSupply - (leverage - 1) * effectiveBorrow;

  return {
    label: c.label,
    baseSupplyApy,
    baseBorrowApy,
    nativeYield,
    nativeSource,
    depositRewardApr,
    borrowRewardApr,
    liquidationLtv,
    maxLeverage,
    leverage,
    totalSupply,
    effectiveBorrow,
    effectiveApy,
  };
}

async function main() {
  console.log(`Multiply APY Comparison — Health Rate ${TARGET_HEALTH}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const results = [];
  for (const c of CANDIDATES) {
    try {
      const r = await analyze(c);
      results.push(r);
    } catch (err) {
      results.push({ label: c.label, error: (err as Error).message });
    }
  }

  // Print detailed breakdown
  for (const r of results) {
    if ('error' in r) {
      console.log(`${r.label}: ERROR — ${r.error}\n`);
      continue;
    }
    console.log(`┌─ ${r.label}`);
    console.log(`│  Supply APY:         ${(r.baseSupplyApy * 100).toFixed(2)}%`);
    console.log(`│  Native Yield:       ${(r.nativeYield * 100).toFixed(2)}% (${r.nativeSource})`);
    console.log(`│  Deposit Reward APR: ${(r.depositRewardApr * 100).toFixed(2)}%`);
    console.log(`│  ─────────────────────────`);
    console.log(`│  Total Supply:       ${(r.totalSupply * 100).toFixed(2)}%`);
    console.log(`│  Borrow APY:         ${(r.baseBorrowApy * 100).toFixed(2)}%`);
    console.log(`│  Borrow Reward APR:  ${(r.borrowRewardApr * 100).toFixed(2)}%`);
    console.log(`│  Effective Borrow:   ${(r.effectiveBorrow * 100).toFixed(2)}%`);
    console.log(`│  ─────────────────────────`);
    console.log(`│  Liq LTV:            ${(r.liquidationLtv * 100).toFixed(1)}%`);
    console.log(`│  Leverage @${TARGET_HEALTH}:    ${r.leverage.toFixed(2)}x (max ${r.maxLeverage.toFixed(2)}x)`);
    console.log(`│`);
    console.log(`└─ Effective APY:      ${(r.effectiveApy * 100).toFixed(2)}%`);
    console.log('');
  }

  // Summary table
  console.log('═══════════════════════════════════════════════════');
  console.log('  SUMMARY (sorted by effective APY)');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  ${'Pair'.padEnd(16)} ${'Leverage'.padEnd(10)} ${'APY'.padEnd(10)} ${'Spread'.padEnd(10)}`);
  console.log(`  ${'-'.repeat(46)}`);

  const sorted = results
    .filter((r): r is Exclude<typeof r, { error: string }> => !('error' in r))
    .sort((a, b) => b.effectiveApy - a.effectiveApy);

  for (const r of sorted) {
    const spread = r.totalSupply - r.effectiveBorrow;
    console.log(
      `  ${r.label.padEnd(16)} ${(r.leverage.toFixed(2) + 'x').padEnd(10)} ${((r.effectiveApy * 100).toFixed(2) + '%').padEnd(10)} ${((spread * 100).toFixed(2) + '%').padEnd(10)}`
    );
  }
  console.log('');
}

main().catch(console.error);
