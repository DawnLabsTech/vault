/**
 * Test: ONyc APY auto-fetch integration in KaminoMultiply.
 * Run: npx tsx scripts/test-onre-integration.ts
 */
import 'dotenv/config';
import { getOnycApy, isOnycToken, ONYC_MINT } from '../src/connectors/defi/onre-apy.js';

async function main() {
  const rpcUrl = process.env.HELIUS_RPC_URL!;

  console.log('=== ONyc Token Detection ===');
  console.log(`ONyc mint: ${isOnycToken(ONYC_MINT)} (expected: true)`);
  console.log(`USDC mint: ${isOnycToken('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')} (expected: false)`);

  console.log('\n=== On-chain APY Fetch ===');
  const result = await getOnycApy(rpcUrl, ONYC_MINT, 0.05);
  console.log(`Source:  ${result.source}`);
  console.log(`APR:     ${(result.apr * 100).toFixed(4)}%`);
  console.log(`APY:     ${(result.apy * 100).toFixed(4)}%`);

  console.log('\n=== Multiply APY Simulation (ONyc/USDC, 2.5x) ===');
  const leverage = 2.5;
  const supplyApy = 0 + result.apy; // Kamino supply APY (0%) + native
  const borrowApy = 0.066; // ~6.6% USDC borrow
  const effectiveApy = leverage * supplyApy - (leverage - 1) * borrowApy;
  console.log(`Native Yield: ${(result.apy * 100).toFixed(2)}%`);
  console.log(`Borrow APY:   ${(borrowApy * 100).toFixed(2)}%`);
  console.log(`Effective:    ${(effectiveApy * 100).toFixed(2)}%`);

  console.log('\n=== Fallback Test (invalid mint) ===');
  const fallbackResult = await getOnycApy(rpcUrl, 'invalid_mint_address_that_does_not_exist', 0.08);
  console.log(`Source:  ${fallbackResult.source} (expected: fallback)`);
  console.log(`APY:     ${(fallbackResult.apy * 100).toFixed(4)}% (expected: 8.0000%)`);
}

main().catch(console.error);
