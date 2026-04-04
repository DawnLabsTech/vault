#!/usr/bin/env tsx
import 'dotenv/config';
import { BinanceRestClient } from '../src/connectors/binance/rest.js';

async function main() {
  const binance = new BinanceRestClient(
    process.env.BINANCE_API_KEY!,
    process.env.BINANCE_API_SECRET!,
    false,
  );

  // Move 5 USDC back: Funding → Spot
  const r = await (binance as any).signedRequest('POST', '/sapi/v1/asset/transfer',
    { type: 'FUNDING_MAIN', asset: 'USDC', amount: '5' }, 'spot');
  console.log('Funding → Spot:', JSON.stringify(r));

  // Verify
  const balance = await (binance as any).signedRequest('POST', '/sapi/v3/asset/getUserAsset',
    { asset: 'USDC' }, 'spot');
  console.log('Spot USDC:', JSON.stringify(balance));
}

main().catch((e) => console.error('Error:', e.message));
