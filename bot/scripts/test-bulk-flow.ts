#!/usr/bin/env tsx
/**
 * Bulk Trade testnet テスト: faucet → アカウント確認 → short open → short close
 *
 * Usage:
 *   npx tsx scripts/test-bulk-flow.ts                 # 全ステップ実行
 *   npx tsx scripts/test-bulk-flow.ts --step status   # 残高・ポジション確認
 *   npx tsx scripts/test-bulk-flow.ts --step funding  # funding rate確認
 *   npx tsx scripts/test-bulk-flow.ts --step faucet   # testnet資金を取得
 *   npx tsx scripts/test-bulk-flow.ts --step short    # short open
 *   npx tsx scripts/test-bulk-flow.ts --step close    # short close
 *
 * Options:
 *   --sol <SOL>   ショート数量 (default: 0.7 ≈ $57 at $80/SOL, above $50 minimum)
 *   --yes         確認プロンプトをスキップ
 */

import { resolve } from 'path';
import { createInterface } from 'readline';

import dotenv from 'dotenv';
dotenv.config({ path: resolve(process.cwd(), '../.env') });
dotenv.config();

import { BulkRestClient } from '../src/connectors/bulk/rest.js';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';

// ── Config ──────────────────────────────────────────────────────────────────

const SYMBOL = 'SOL-USD';

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const stepArg = getArg('step');
const solAmount = parseFloat(getArg('sol') ?? '0.7');
const skipConfirm = hasFlag('yes');

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, d = 4): string {
  return n.toFixed(d);
}

async function confirm(msg: string): Promise<void> {
  if (skipConfirm) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve, reject) => {
    rl.question(`\n${msg} (y/N) `, (ans) => {
      rl.close();
      if (ans.toLowerCase() === 'y') resolve();
      else reject(new Error('Aborted by user'));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function stepStatus(client: BulkRestClient): Promise<void> {
  console.log('\n--- Bulk Account Status ---');
  const account = await client.getAccount();
  const { totalBalance, availableBalance, marginUsed, notional, unrealizedPnl } = account.margin;

  console.log(`  Bulk address  : ${client.accountPubkey}`);
  console.log(`  Total balance : $${fmt(totalBalance)}`);
  console.log(`  Available     : $${fmt(availableBalance)}`);
  console.log(`  Margin used   : $${fmt(marginUsed)}`);
  console.log(`  Notional      : $${fmt(notional)}`);
  console.log(`  Unrealized PnL: $${fmt(unrealizedPnl)}`);

  if (account.positions.length === 0) {
    console.log('\n  Positions: none');
  } else {
    console.log('\n  Positions:');
    for (const p of account.positions) {
      const side = p.size < 0 ? 'SHORT' : 'LONG';
      const absSize = Math.abs(p.size);
      console.log(`    ${p.symbol} ${side} ${fmt(absSize)} @ $${fmt(p.price)}`);
      console.log(`      Mark px       : $${fmt(p.fairPrice)}`);
      console.log(`      Unrealized PnL: $${fmt(p.unrealizedPnl)}`);
      console.log(`      Liquidation px: $${fmt(p.liquidationPrice)}`);
    }
  }

  if (account.openOrders.length > 0) {
    console.log('\n  Open orders:');
    for (const o of account.openOrders) {
      console.log(`    ${o.symbol} ${o.side.toUpperCase()} ${fmt(o.size)} @ $${fmt(o.price)}`);
    }
  }
}

async function stepFunding(client: BulkRestClient): Promise<void> {
  console.log('\n--- Funding Rate ---');
  const stats = await client.getStats(SYMBOL);
  const market = client.getMarketStats(stats, SYMBOL);
  const rate = stats.funding.rates[SYMBOL];

  if (!market || !rate) {
    console.log(`  No data for ${SYMBOL}`);
    return;
  }

  const hourlyPct = rate.current * 100;
  const annualizedPct = rate.annualized * 100;

  console.log(`  Symbol         : ${SYMBOL}`);
  console.log(`  Mark price     : $${fmt(market.markPrice)}`);
  console.log(`  Last price     : $${fmt(market.lastPrice)}`);
  console.log(`  Hourly funding : ${hourlyPct.toFixed(6)}%`);
  console.log(`  Annualized     : ${annualizedPct.toFixed(4)}%`);
  console.log(`  Open interest  : ${fmt(market.openInterest)} SOL`);
}

async function stepFaucet(client: BulkRestClient): Promise<void> {
  console.log('\n--- Testnet Faucet ---');
  console.log(`  Requesting funds for: ${client.accountPubkey}`);
  await confirm('Request testnet USDC from faucet?');
  try {
    await client.requestFaucet();
    console.log('  Faucet request sent. Waiting 3s for settlement...');
    await sleep(3000);
    await stepStatus(client);
  } catch (err) {
    console.log(`  Faucet error: ${(err as Error).message}`);
    console.log('  (Faucet is rate-limited to once per hour. Try again later if needed.)');
  }
}

async function stepShort(client: BulkRestClient): Promise<void> {
  console.log(`\n--- Open Short: ${solAmount} SOL ---`);
  const stats = await client.getStats(SYMBOL);
  const market = client.getMarketStats(stats, SYMBOL);
  if (!market) throw new Error(`No market data for ${SYMBOL}`);

  const markPrice = market.markPrice;
  const notional = solAmount * markPrice;
  console.log(`  Mark price : $${fmt(markPrice)}`);
  console.log(`  Size       : ${solAmount} SOL`);
  console.log(`  Notional   : $${fmt(notional)} (min $50 required)`);

  if (notional < 50) {
    console.log(`\n  Notional $${fmt(notional)} < $50 minimum. Increase --sol.`);
    process.exit(1);
  }

  const account = await client.getAccount();
  if (account.margin.availableBalance < notional / 50) {
    console.log(`\n  Insufficient margin. Available: $${fmt(account.margin.availableBalance)}`);
    console.log('  Run --step faucet first to fund your testnet account.');
    process.exit(1);
  }

  await confirm(`Open SHORT ${solAmount} SOL @ ~$${fmt(markPrice)}?`);

  const result = await client.openShort(SYMBOL, solAmount);
  console.log('\n  Short opened:');
  console.log(`    Size       : ${result.size} SOL`);
  console.log(`    Entry price: $${fmt(result.entryPrice)}`);
  console.log(`    Order ID   : ${result.orderId}`);

  await sleep(1000);
  await stepStatus(client);
}

async function stepClose(client: BulkRestClient): Promise<void> {
  console.log('\n--- Close Short ---');

  const position = await client.getPosition(SYMBOL);
  if (!position || position.size >= 0) {
    console.log(`  No open short position for ${SYMBOL}`);
    return;
  }

  const absSize = Math.abs(position.size);
  console.log(`  Current: SHORT ${fmt(absSize)} SOL @ $${fmt(position.price)}`);
  console.log(`  Mark px: $${fmt(position.fairPrice)}`);
  console.log(`  PnL    : $${fmt(position.unrealizedPnl)}`);

  await confirm(`Close ${fmt(absSize)} SOL short?`);

  const result = await client.closeShort(SYMBOL);
  console.log('\n  Short closed:');
  console.log(`    Realized PnL: $${fmt(result.pnl)}`);
  console.log(`    Order ID    : ${result.orderId}`);

  await sleep(1000);
  await stepStatus(client);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Bulk Trade Testnet Flow ===');

  const wallet = loadWalletFromEnv();
  const secretKeySeed = wallet.secretKey.slice(0, 32);
  const client = new BulkRestClient(secretKeySeed, /* testnet */ true);

  console.log(`Solana wallet : ${wallet.publicKey}`);
  console.log(`Bulk address  : ${client.accountPubkey}`);
  console.log('(Bulk address differs from Solana address — this is expected)\n');

  const step = stepArg ?? 'all';

  try {
    switch (step) {
      case 'status':
        await stepStatus(client);
        break;
      case 'funding':
        await stepFunding(client);
        break;
      case 'faucet':
        await stepFaucet(client);
        break;
      case 'short':
        await stepShort(client);
        break;
      case 'close':
        await stepClose(client);
        break;
      case 'all':
        await stepStatus(client);
        await stepFunding(client);
        await stepFaucet(client);
        await stepShort(client);
        await stepClose(client);
        break;
      default:
        console.error(`Unknown step: ${step}`);
        process.exit(1);
    }
  } catch (err) {
    console.error('\nError:', (err as Error).message);
    process.exit(1);
  }

  console.log('\nDone.');
}

main();
