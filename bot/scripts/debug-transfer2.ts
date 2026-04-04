#!/usr/bin/env tsx
/**
 * Debug: try different transfer types and assets
 */
import 'dotenv/config';
import { BinanceRestClient } from '../src/connectors/binance/rest.js';

async function main() {
  const binance = new BinanceRestClient(
    process.env.BINANCE_API_KEY!,
    process.env.BINANCE_API_SECRET!,
    false,
  );

  // 1. Try USDT transfer (to check if it's USDC-specific)
  console.log('=== Test 1: MAIN_UMFUTURE USDT ===');
  try {
    const r = await (binance as any).signedRequest('POST', '/sapi/v1/asset/transfer',
      { type: 'MAIN_UMFUTURE', asset: 'USDT', amount: '1' }, 'spot');
    console.log('Success:', r);
  } catch (e: any) {
    console.log('Error:', e.message);
  }

  // 2. Try via /sapi/v1/futures/transfer (older endpoint)
  console.log('\n=== Test 2: /sapi/v1/futures/transfer USDC ===');
  try {
    const r = await (binance as any).signedRequest('POST', '/sapi/v1/futures/transfer',
      { asset: 'USDC', amount: '5', type: '1' }, 'spot');
    console.log('Success:', r);
  } catch (e: any) {
    console.log('Error:', e.message);
  }

  // 3. Try MAIN_CMFUTURE (coin-M)
  console.log('\n=== Test 3: MAIN_CMFUTURE USDC ===');
  try {
    const r = await (binance as any).signedRequest('POST', '/sapi/v1/asset/transfer',
      { type: 'MAIN_CMFUTURE', asset: 'USDC', amount: '5' }, 'spot');
    console.log('Success:', r);
  } catch (e: any) {
    console.log('Error:', e.message);
  }

  // 4. Check if Binance web Futures transfer works — try with Futures API directly
  console.log('\n=== Test 4: Check Futures account multiAssetMargin ===');
  try {
    const account = await binance.getAccount();
    console.log('multiAssetsMargin:', (account as any).multiAssetsMargin);
    console.log('canTrade:', (account as any).canTrade);
    console.log('canDeposit:', (account as any).canDeposit);
    console.log('totalInitialMargin:', (account as any).totalInitialMargin);
    console.log('totalMaintMargin:', (account as any).totalMaintMargin);
  } catch (e: any) {
    console.log('Error:', e.message);
  }

  // 5. Check account status
  console.log('\n=== Test 5: Account status ===');
  try {
    const r = await (binance as any).signedRequest('GET', '/sapi/v1/account/status', {}, 'spot');
    console.log('Account status:', JSON.stringify(r));
  } catch (e: any) {
    console.log('Error:', e.message);
  }
}

main().catch(console.error);
