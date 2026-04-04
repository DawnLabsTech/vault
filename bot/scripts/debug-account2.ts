#!/usr/bin/env tsx
import 'dotenv/config';
import { createHmac } from 'crypto';

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

async function signedGet(baseUrl: string, path: string, params: Record<string, string> = {}) {
  const timestamp = Date.now().toString();
  const allParams = { ...params, timestamp };
  const qs = new URLSearchParams(allParams).toString();
  const signature = createHmac('sha256', API_SECRET).update(qs).digest('hex');
  const url = `${baseUrl}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, { headers: { 'X-MBX-APIKEY': API_KEY } });
  return res.json();
}

async function main() {
  // 1. Check Spot balance
  console.log('=== Spot Account Balance ===');
  const spotAccount = await signedGet('https://api.binance.com', '/api/v3/account') as any;
  if (spotAccount.balances) {
    const nonZero = spotAccount.balances.filter(
      (b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
    );
    for (const b of nonZero) {
      console.log(`  ${b.asset}: free=${b.free}, locked=${b.locked}`);
    }
    if (nonZero.length === 0) console.log('  (no balances)');
    console.log(`  Account type: ${spotAccount.accountType}`);
  } else {
    console.log('  Error:', JSON.stringify(spotAccount).slice(0, 200));
  }

  // 2. Check Funding wallet
  console.log('\n=== Funding Wallet ===');
  const funding = await signedGet('https://api.binance.com', '/sapi/v1/asset/get-funding-asset', { asset: 'USDC' }) as any;
  if (Array.isArray(funding)) {
    for (const f of funding) {
      console.log(`  ${f.asset}: free=${f.free}, locked=${f.locked}, frozen=${f.frozen}`);
    }
    if (funding.length === 0) console.log('  (no USDC in funding)');
  } else {
    console.log('  Response:', JSON.stringify(funding).slice(0, 200));
  }

  // 3. Check Futures account type (v3 endpoint for unified accounts)
  console.log('\n=== Futures Account (v2) ===');
  const futuresAccount = await signedGet('https://fapi.binance.com', '/fapi/v2/account') as any;
  console.log('  multiAssetsMargin:', futuresAccount.multiAssetsMargin);
  console.log('  canTrade:', futuresAccount.canTrade);
  console.log('  canDeposit:', futuresAccount.canDeposit);
  console.log('  totalWalletBalance:', futuresAccount.totalWalletBalance);
  console.log('  totalMarginBalance:', futuresAccount.totalMarginBalance);
  console.log('  availableBalance:', futuresAccount.availableBalance);
  // Check USDC asset specifically
  if (futuresAccount.assets) {
    const usdcAsset = futuresAccount.assets.find((a: any) => a.asset === 'USDC');
    if (usdcAsset) {
      console.log('  USDC asset:', JSON.stringify(usdcAsset));
    }
  }

  // 4. Check if portfolio margin
  console.log('\n=== Portfolio Margin Check ===');
  try {
    const pmAccount = await signedGet('https://papi.binance.com', '/papi/v1/balance') as any;
    if (Array.isArray(pmAccount)) {
      const nonZero = pmAccount.filter((b: any) => parseFloat(b.totalWalletBalance || '0') > 0);
      for (const b of nonZero) {
        console.log(`  PM ${b.asset}: ${JSON.stringify(b)}`);
      }
      if (nonZero.length === 0) console.log('  (no PM balances)');
    } else {
      console.log('  Not a PM account or error:', JSON.stringify(pmAccount).slice(0, 200));
    }
  } catch (e) {
    console.log('  PM error:', (e as Error).message);
  }

  // 5. Check universal transfer capability
  console.log('\n=== API Permissions Check ===');
  const apiPerms = await signedGet('https://api.binance.com', '/sapi/v1/account/apiRestrictions') as any;
  console.log('  enableFutures:', apiPerms.enableFutures);
  console.log('  enableInternalTransfer:', apiPerms.enableInternalTransfer);
  console.log('  enableWithdrawals:', apiPerms.enableWithdrawals);
  console.log('  permitsUniversalTransfer:', apiPerms.permitsUniversalTransfer);
  console.log('  enableSpotAndMarginTrading:', apiPerms.enableSpotAndMarginTrading);
}

main().catch(console.error);
