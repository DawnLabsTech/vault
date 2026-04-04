/**
 * Check Multiply APY for various pairs using Kamino SDK.
 * Run: npx tsx scripts/check-multiply-apy.ts
 */
import 'dotenv/config';
import {
  KaminoMarket,
  DEFAULT_RECENT_SLOT_DURATION_MS,
  PROGRAM_ID,
} from '@kamino-finance/klend-sdk';
import { address, createSolanaRpc } from '@solana/kit';
import Decimal from 'decimal.js';

const RPC_URL = process.env.HELIUS_RPC_URL || '';
if (!RPC_URL) {
  console.error('HELIUS_RPC_URL not set');
  process.exit(1);
}

const rpc = createSolanaRpc(RPC_URL as any);

interface PairConfig {
  label: string;
  marketAddress: string;
  collToken: string;
  debtToken: string;
  collSymbol: string;
  debtSymbol: string;
  nativeYield?: number; // manual override
}

const PAIRS: PairConfig[] = [
  {
    label: 'USDG/PYUSD',
    marketAddress: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
    collToken: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
    debtToken: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
    collSymbol: 'USDG',
    debtSymbol: 'PYUSD',
  },
  {
    label: 'USDC/USDT',
    marketAddress: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
    collToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    debtToken: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    collSymbol: 'USDC',
    debtSymbol: 'USDT',
  },
  {
    label: 'ONyc/USDG (RWA Loop)',
    marketAddress: '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8',
    collToken: '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5', // ONyc
    debtToken: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
    collSymbol: 'ONyc',
    debtSymbol: 'USDG',
    nativeYield: 0.05, // ~5% T-bill yield, manual estimate
  },
];

// Simple price fetcher using Jupiter
async function getTokenPrice(mint: string): Promise<number> {
  try {
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
    if (!res.ok) return 0;
    const data = (await res.json()) as any;
    return parseFloat(data.data?.[mint]?.price ?? '0');
  } catch {
    return 0;
  }
}

async function analyzeMarket(pair: PairConfig) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${pair.label}`);
  console.log(`${'='.repeat(60)}`);

  const market = await KaminoMarket.load(
    rpc,
    address(pair.marketAddress),
    DEFAULT_RECENT_SLOT_DURATION_MS,
  );
  if (!market) {
    console.log('  ❌ Failed to load market');
    return;
  }
  await market.loadReserves();

  const slotResult = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const slot = typeof slotResult === 'object' ? (slotResult as any).value ?? slotResult : slotResult;

  const collReserve = market.getReserveByMint(address(pair.collToken));
  const debtReserve = market.getReserveByMint(address(pair.debtToken));

  if (!collReserve || !debtReserve) {
    console.log('  ❌ Reserve not found');
    return;
  }

  // 1. Base APYs
  const supplyApy = collReserve.totalSupplyAPY(BigInt(slot));
  const borrowApy = debtReserve.totalBorrowAPY(BigInt(slot));

  console.log(`\n  [Base Rates]`);
  console.log(`    ${pair.collSymbol} Supply APY:  ${(supplyApy * 100).toFixed(4)}%`);
  console.log(`    ${pair.debtSymbol} Borrow APY:  ${(borrowApy * 100).toFixed(4)}%`);
  console.log(`    Spread:              ${((supplyApy - borrowApy) * 100).toFixed(4)}%`);

  // 2. Reward APRs
  let depositRewardApr = 0;
  let borrowRewardApr = 0;
  try {
    const priceFn = async (mint: string) => getTokenPrice(mint);
    const farmInfo = await market.getReserveFarmInfo(
      address(pair.collToken),
      priceFn as any,
    );
    depositRewardApr = farmInfo.depositingRewards.rewardApr.toNumber();
    console.log(`\n  [Collateral Deposit Rewards]`);
    console.log(`    Reward APR:          ${(depositRewardApr * 100).toFixed(4)}%`);
    console.log(`    Reward Mint:         ${farmInfo.depositingRewards.rewardMint}`);
    console.log(`    Reward Price:        $${farmInfo.depositingRewards.rewardPrice.toFixed(4)}`);
    console.log(`    Rewards/sec:         ${farmInfo.depositingRewards.rewardsPerSecond.toFixed(6)}`);
  } catch (err) {
    console.log(`\n  [Collateral Deposit Rewards] None or error: ${(err as Error).message?.slice(0, 80)}`);
  }

  try {
    const priceFn = async (mint: string) => getTokenPrice(mint);
    const farmInfo = await market.getReserveFarmInfo(
      address(pair.debtToken),
      priceFn as any,
    );
    borrowRewardApr = farmInfo.borrowingRewards.rewardApr.toNumber();
    console.log(`\n  [Debt Borrow Rewards]`);
    console.log(`    Reward APR:          ${(borrowRewardApr * 100).toFixed(4)}%`);
    console.log(`    Reward Mint:         ${farmInfo.borrowingRewards.rewardMint}`);
  } catch (err) {
    console.log(`\n  [Debt Borrow Rewards] None or error: ${(err as Error).message?.slice(0, 80)}`);
  }

  // 3. LTV & Leverage
  let maxLeverage = 0;
  let liquidationLtv = 0;
  let maxLtv = 0;
  try {
    const ltvInfo = market.getMaxAndLiquidationLtvAndBorrowFactorForPair(
      address(pair.collToken),
      address(pair.debtToken),
    );
    liquidationLtv = ltvInfo.liquidationLtv;
    maxLtv = ltvInfo.maxLtv;
    maxLeverage = market.getMaxLeverageForPair(
      address(pair.collToken),
      address(pair.debtToken),
    );
  } catch (err) {
    console.log(`\n  [LTV] Error: ${(err as Error).message?.slice(0, 80)}`);
  }

  console.log(`\n  [Leverage]`);
  console.log(`    Max LTV:             ${(maxLtv * 100).toFixed(1)}%`);
  console.log(`    Liquidation LTV:     ${(liquidationLtv * 100).toFixed(1)}%`);
  console.log(`    Max Leverage:        ${maxLeverage.toFixed(2)}x`);

  // 4. Calculate effective APY at various health rates
  const nativeYield = pair.nativeYield ?? 0;
  const totalSupplyYield = supplyApy + nativeYield + depositRewardApr;
  const effectiveBorrowCost = borrowApy - borrowRewardApr;

  console.log(`\n  [APY Calculation]`);
  if (nativeYield > 0) {
    console.log(`    Native Yield:        ${(nativeYield * 100).toFixed(2)}%`);
  }
  console.log(`    Total Supply Yield:  ${(totalSupplyYield * 100).toFixed(4)}% (supplyAPY + native + rewards)`);
  console.log(`    Effective Borrow:    ${(effectiveBorrowCost * 100).toFixed(4)}% (borrowAPY - rewards)`);
  console.log(`    Net Spread:          ${((totalSupplyYield - effectiveBorrowCost) * 100).toFixed(4)}%`);

  console.log(`\n  [Effective APY by Health Rate]`);
  console.log(`    ${'Health'.padEnd(10)} ${'Leverage'.padEnd(12)} ${'Effective APY'.padEnd(15)} Note`);
  console.log(`    ${'-'.repeat(50)}`);

  for (const health of [1.03, 1.05, 1.10, 1.15, 1.20]) {
    if (liquidationLtv <= 0) {
      console.log(`    ${health.toFixed(2).padEnd(10)} N/A`);
      continue;
    }

    let leverage: number;
    if (health <= liquidationLtv) {
      leverage = maxLeverage;
    } else {
      leverage = health / (health - liquidationLtv);
    }
    leverage = Math.min(leverage, maxLeverage);

    const effectiveApy = leverage * totalSupplyYield - (leverage - 1) * effectiveBorrowCost;

    const note = health === 1.15 ? '<-- target' : health === 1.05 ? '<-- emergency' : '';
    console.log(
      `    ${health.toFixed(2).padEnd(10)} ${leverage.toFixed(2).concat('x').padEnd(12)} ${(effectiveApy * 100).toFixed(2).concat('%').padEnd(15)} ${note}`,
    );
  }

  // Compare with Kamino API
  console.log(`\n  [Kamino API comparison]`);
  try {
    const res = await fetch(`https://api.kamino.finance/kamino-market/${pair.marketAddress}/reserves/metrics`);
    const data = (await res.json()) as any[];
    const collMetrics = data.find((r: any) => r.liquidityTokenMint === pair.collToken);
    const debtMetrics = data.find((r: any) => r.liquidityTokenMint === pair.debtToken);
    console.log(`    API ${pair.collSymbol} supplyApy: ${(parseFloat(collMetrics?.supplyApy ?? '0') * 100).toFixed(4)}%`);
    console.log(`    API ${pair.debtSymbol} borrowApy: ${(parseFloat(debtMetrics?.borrowApy ?? '0') * 100).toFixed(4)}%`);
    console.log(`    SDK ${pair.collSymbol} supplyApy: ${(supplyApy * 100).toFixed(4)}%`);
    console.log(`    SDK ${pair.debtSymbol} borrowApy: ${(borrowApy * 100).toFixed(4)}%`);
  } catch {
    console.log('    API comparison failed');
  }
}

async function main() {
  console.log('Kamino Multiply APY Analysis');
  console.log(`Time: ${new Date().toISOString()}`);

  for (const pair of PAIRS) {
    await analyzeMarket(pair);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('Done');
}

main().catch(console.error);
