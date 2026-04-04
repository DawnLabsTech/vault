#!/usr/bin/env tsx
/**
 * Binance API key permissions & account status debug
 */
import 'dotenv/config';
import { BinanceRestClient } from '../src/connectors/binance/rest.js';

async function main() {
  const apiKey = process.env.BINANCE_API_KEY || '';
  const apiSecret = process.env.BINANCE_API_SECRET || '';
  if (!apiKey || !apiSecret) throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET not set');

  const binance = new BinanceRestClient(apiKey, apiSecret, false);

  // 1. Check API restrictions
  console.log('=== API Key Restrictions ===');
  try {
    const restrictions = await (binance as any).signedRequest('GET', '/sapi/v1/account/apiRestrictions', {}, 'spot');
    console.log(JSON.stringify(restrictions, null, 2));
  } catch (e: any) {
    console.error('Error:', e.message);
  }

  // 2. Check Futures account status
  console.log('\n=== Futures Account ===');
  try {
    const account = await binance.getAccount();
    console.log('canTrade:', (account as any).canTrade);
    console.log('canDeposit:', (account as any).canDeposit);
    console.log('canWithdraw:', (account as any).canWithdraw);
    console.log('feeTier:', (account as any).feeTier);
    console.log('totalWalletBalance:', (account as any).totalWalletBalance);
    console.log('multiAssetsMargin:', (account as any).multiAssetsMargin);
  } catch (e: any) {
    console.error('Error:', e.message);
  }

  // 3. Try transfer with exact same params via transferInternal (existing method)
  console.log('\n=== Transfer test via transferInternal ===');
  try {
    const result = await binance.transferInternal('MAIN_UMFUTURE', 'USDC', '5');
    console.log('Success:', result);
  } catch (e: any) {
    console.error('Error:', e.message);
  }
}

main().catch((err) => {
  console.error(`\n❌ Error: ${(err as Error).message}`);
  process.exit(1);
});
