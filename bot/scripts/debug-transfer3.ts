#!/usr/bin/env tsx
/**
 * Debug: try alternative transfer routes
 */
import 'dotenv/config';
import { BinanceRestClient } from '../src/connectors/binance/rest.js';

async function main() {
  const binance = new BinanceRestClient(
    process.env.BINANCE_API_KEY!,
    process.env.BINANCE_API_SECRET!,
    false,
  );

  // 1. Spot → Funding
  console.log('=== Test 1: MAIN_FUNDING (Spot → Funding) ===');
  try {
    const r = await (binance as any).signedRequest('POST', '/sapi/v1/asset/transfer',
      { type: 'MAIN_FUNDING', asset: 'USDC', amount: '5' }, 'spot');
    console.log('Success:', JSON.stringify(r));
  } catch (e: any) {
    console.log('Error:', e.message);
  }

  // 2. Funding → Futures
  console.log('\n=== Test 2: FUNDING_UMFUTURE (Funding → Futures) ===');
  try {
    const r = await (binance as any).signedRequest('POST', '/sapi/v1/asset/transfer',
      { type: 'FUNDING_UMFUTURE', asset: 'USDC', amount: '5' }, 'spot');
    console.log('Success:', JSON.stringify(r));
  } catch (e: any) {
    console.log('Error:', e.message);
  }

  // 3. Try with recvWindow
  console.log('\n=== Test 3: MAIN_UMFUTURE with recvWindow ===');
  try {
    const r = await (binance as any).signedRequest('POST', '/sapi/v1/asset/transfer',
      { type: 'MAIN_UMFUTURE', asset: 'USDC', amount: '5', recvWindow: '60000' }, 'spot');
    console.log('Success:', JSON.stringify(r));
  } catch (e: any) {
    console.log('Error:', e.message);
  }

  // 4. Check transfer history (to see if any past transfers exist)
  console.log('\n=== Test 4: Transfer history MAIN_UMFUTURE ===');
  try {
    const r = await (binance as any).signedRequest('GET', '/sapi/v1/asset/transfer',
      { type: 'MAIN_UMFUTURE' }, 'spot');
    console.log('History:', JSON.stringify(r));
  } catch (e: any) {
    console.log('Error:', e.message);
  }

  // 5. Check user asset (spot balances)
  console.log('\n=== Test 5: Spot USDC balance ===');
  try {
    const r = await (binance as any).signedRequest('POST', '/sapi/v3/asset/getUserAsset',
      { asset: 'USDC' }, 'spot');
    console.log('Spot USDC:', JSON.stringify(r));
  } catch (e: any) {
    console.log('Error:', e.message);
  }
}

main().catch(console.error);
