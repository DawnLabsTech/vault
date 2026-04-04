#!/usr/bin/env tsx
/**
 * Continue from Step 1c: Spot→Futures → short → close → withdraw
 */
import 'dotenv/config';
import { BinanceRestClient } from '../src/connectors/binance/rest.js';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';

const SYMBOL = 'SOLUSDC';
const SHORT_SOL = 0.1;

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function log(msg: string): void {
  console.log(`[${now()}] ${msg}`);
}

async function showStatus(binance: BinanceRestClient) {
  const balances = await binance.getBalance();
  const usdc = balances.find((b) => b.asset === 'USDC');
  console.log(`  Futures USDC: ${usdc ? parseFloat(usdc.balance).toFixed(2) : '0.00'} (avail: ${usdc ? parseFloat(usdc.availableBalance).toFixed(2) : '0.00'})`);
  const positions = await binance.getPosition(SYMBOL);
  const active = positions.filter((p) => parseFloat(p.positionAmt) !== 0);
  if (active.length === 0) {
    console.log('  Position: none');
  } else {
    for (const p of active) {
      console.log(`  Position: ${p.positionAmt} SOL @ $${parseFloat(p.entryPrice).toFixed(2)}, uPnL: $${parseFloat(p.unrealizedProfit).toFixed(4)}`);
    }
  }
}

async function main() {
  const binance = new BinanceRestClient(
    process.env.BINANCE_API_KEY || '',
    process.env.BINANCE_API_SECRET || '',
    false,
  );
  const wallet = loadWalletFromEnv();
  const walletAddress = process.env.SOLANA_WALLET_ADDRESS || wallet.publicKey;

  // Step 1c: Spot → Futures
  console.log('\n── Step 1c: Spot → Futures ──');
  try {
    // Try Funding → Futures first, then Spot → Futures
    let transferred = false;
    for (const transferType of ['FUNDING_UMFUTURE', 'MAIN_UMFUTURE']) {
      try {
        log(`Trying ${transferType}...`);
        const result = await binance.transferInternal(transferType, 'USDC', '16');
        log(`✅ ${transferType}: tranId=${result.tranId}`);
        transferred = true;
        break;
      } catch (err) {
        log(`${transferType} failed: ${(err as Error).message}`);
      }
    }
    if (!transferred) log('⚠️  All transfer attempts failed');
  } catch (e) {
    log(`Transfer error (may already be in futures): ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
  await showStatus(binance);

  // Step 2: Open short
  console.log('\n── Step 2: Open perp short ──');
  await binance.setLeverage(SYMBOL, 1);
  const order = await binance.placeOrder({
    symbol: SYMBOL,
    side: 'SELL',
    type: 'MARKET',
    quantity: SHORT_SOL.toString(),
  });
  log(`✅ Short opened: ${order.executedQty} SOL @ $${parseFloat(order.avgPrice).toFixed(2)} (orderId: ${order.orderId})`);
  await showStatus(binance);

  // Step 3: Close short
  console.log('\n── Step 3: Close perp short ──');
  const positions = await binance.getPosition(SYMBOL);
  const pos = positions.find((p) => parseFloat(p.positionAmt) !== 0);
  if (!pos) throw new Error('No position found');
  const posSize = Math.abs(parseFloat(pos.positionAmt));
  const closeOrder = await binance.placeOrder({
    symbol: SYMBOL,
    side: 'BUY',
    type: 'MARKET',
    quantity: posSize.toString(),
    reduceOnly: true,
  });
  log(`✅ Short closed: ${closeOrder.executedQty} SOL @ $${parseFloat(closeOrder.avgPrice).toFixed(2)} (orderId: ${closeOrder.orderId})`);
  await showStatus(binance);

  // Step 4: Futures → Spot → Withdraw
  console.log('\n── Step 4: Withdraw ──');
  const balAfterClose = await binance.getBalance();
  const usdcAfter = balAfterClose.find((b) => b.asset === 'USDC');
  const futuresAvail = usdcAfter ? parseFloat(usdcAfter.availableBalance) : 0;

  if (futuresAvail > 0) {
    log(`Transferring ${futuresAvail.toFixed(2)} USDC Futures → Spot...`);
    await binance.transferFuturesToSpot('USDC', futuresAvail.toFixed(2));
    log('✅ Futures → Spot done');
    await new Promise((r) => setTimeout(r, 2000));
  }

  const withdrawAmt = Math.floor(futuresAvail * 100) / 100;
  log(`Withdrawing ${withdrawAmt} USDC to ${walletAddress.slice(0, 8)}... (SOL network)`);
  const wResult = await binance.withdraw('USDC', walletAddress, withdrawAmt.toString(), 'SOL');
  log(`✅ Withdrawal submitted: id=${wResult.id}`);
  log('   Binance withdrawals typically take 5-30 minutes');

  console.log('\n✅ Full flow test complete');
}

main().catch((err) => {
  console.error(`\n❌ Error: ${(err as Error).message}`);
  process.exit(1);
});
