#!/usr/bin/env tsx
import 'dotenv/config';
import { BinanceRestClient } from '../src/connectors/binance/rest.js';

async function main() {
  const binance = new BinanceRestClient(
    process.env.BINANCE_API_KEY || '',
    process.env.BINANCE_API_SECRET || '',
    false
  );

  // Try different network names
  for (const network of ['SOL', 'SOLANA', 'SPL']) {
    try {
      const info = await binance.getDepositAddress('USDC', network);
      console.log(`Network=${network}: address=${info.address}, tag=${info.tag}, isDefault=${info.isDefault}`);
    } catch (e) {
      console.log(`Network=${network}: ERROR - ${(e as Error).message}`);
    }
  }
}

main().catch(console.error);
