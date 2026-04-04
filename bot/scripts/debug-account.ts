#!/usr/bin/env tsx
import 'dotenv/config';
import { BinanceRestClient } from '../src/connectors/binance/rest.js';

async function main() {
  const binance = new BinanceRestClient(
    process.env.BINANCE_API_KEY || '',
    process.env.BINANCE_API_SECRET || '',
    false,
  );

  // Check futures account
  console.log('=== Futures Account ===');
  const account = await binance.getAccount();
  console.log('  canTrade:', account.canTrade);
  console.log('  canDeposit:', account.canDeposit);
  console.log('  totalWalletBalance:', account.totalWalletBalance);
  console.log('  availableBalance:', account.availableBalance);

  // List all non-zero assets
  for (const a of account.assets) {
    const bal = parseFloat(a.balance);
    if (bal !== 0) {
      console.log(`  Asset ${a.asset}: balance=${a.balance}, available=${a.availableBalance}`);
    }
  }

  // Check all balances via /fapi/v2/balance
  console.log('\n=== Futures Balances ===');
  const balances = await binance.getBalance();
  for (const b of balances) {
    const bal = parseFloat(b.balance);
    if (bal !== 0) {
      console.log(`  ${b.asset}: balance=${b.balance}, available=${b.availableBalance}`);
    }
  }

  // Check Spot balance via /sapi endpoint (if available)
  console.log('\n=== Spot-like info (deposit history) ===');
  const deposits = await binance.getDepositHistory('USDC');
  const recent = deposits.filter((d) => Date.now() - d.insertTime < 3600000);
  for (const d of recent) {
    console.log(`  Deposit: ${d.amount} ${d.coin} status=${d.status} network=${d.network} at=${new Date(d.insertTime).toISOString()}`);
  }
}

main().catch(console.error);
