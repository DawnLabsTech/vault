#!/usr/bin/env tsx
/**
 * Binance Spot ↔ Futures 振替テスト
 *
 * Usage:
 *   npx tsx scripts/test-transfer.ts                    # 残高確認のみ
 *   npx tsx scripts/test-transfer.ts --spot-to-futures 5 # Spot→Futures 5 USDC
 *   npx tsx scripts/test-transfer.ts --futures-to-spot 5 # Futures→Spot 5 USDC
 */
import 'dotenv/config';
import { BinanceRestClient } from '../src/connectors/binance/rest.js';

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const spotToFuturesAmt = getArg('spot-to-futures');
const futuresToSpotAmt = getArg('futures-to-spot');

async function main() {
  const apiKey = process.env.BINANCE_API_KEY || '';
  const apiSecret = process.env.BINANCE_API_SECRET || '';
  if (!apiKey || !apiSecret) throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET not set');

  const binance = new BinanceRestClient(apiKey, apiSecret, false);

  // Show Futures balance
  console.log('=== Futures Balance ===');
  const balances = await binance.getBalance();
  const usdc = balances.find((b) => b.asset === 'USDC');
  console.log(`  USDC: balance=${usdc ? usdc.balance : '0'}, available=${usdc ? usdc.availableBalance : '0'}`);

  // Spot→Futures
  if (spotToFuturesAmt) {
    console.log(`\n--- Transferring ${spotToFuturesAmt} USDC: Spot → Futures ---`);
    try {
      const result = await binance.transferSpotToFutures('USDC', spotToFuturesAmt);
      console.log(`✅ Success! tranId: ${result.tranId}`);
    } catch (e: any) {
      console.error(`❌ Failed: ${e.message}`);
    }

    // Check updated balance
    const updated = await binance.getBalance();
    const updatedUsdc = updated.find((b) => b.asset === 'USDC');
    console.log(`  Futures USDC after: balance=${updatedUsdc ? updatedUsdc.balance : '0'}, available=${updatedUsdc ? updatedUsdc.availableBalance : '0'}`);
  }

  // Futures→Spot
  if (futuresToSpotAmt) {
    console.log(`\n--- Transferring ${futuresToSpotAmt} USDC: Futures → Spot ---`);
    try {
      const result = await binance.transferFuturesToSpot('USDC', futuresToSpotAmt);
      console.log(`✅ Success! tranId: ${result.tranId}`);
    } catch (e: any) {
      console.error(`❌ Failed: ${e.message}`);
    }

    // Check updated balance
    const updated = await binance.getBalance();
    const updatedUsdc = updated.find((b) => b.asset === 'USDC');
    console.log(`  Futures USDC after: balance=${updatedUsdc ? updatedUsdc.balance : '0'}, available=${updatedUsdc ? updatedUsdc.availableBalance : '0'}`);
  }

  if (!spotToFuturesAmt && !futuresToSpotAmt) {
    console.log('\nUsage:');
    console.log('  npx tsx scripts/test-transfer.ts --spot-to-futures <amount>');
    console.log('  npx tsx scripts/test-transfer.ts --futures-to-spot <amount>');
  }
}

main().catch((err) => {
  console.error(`\n❌ Error: ${(err as Error).message}`);
  process.exit(1);
});
