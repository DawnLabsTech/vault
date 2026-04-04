/**
 * Deposit ONyc (already in wallet) into ONyc/USDC Multiply position.
 * Run: npx tsx scripts/deposit-onyc-usdc.ts
 */
import 'dotenv/config';
import { KaminoMultiplyLending, type KaminoMultiplyConfig } from '../src/connectors/defi/kamino-multiply.js';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';

// Deposit ONyc directly (already swapped from 50 USDC)
const DEPOSIT_AMOUNT = 5; // ONyc — small test first

const config: KaminoMultiplyConfig = {
  market: '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8',
  collToken: '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5', // ONyc
  debtToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  label: 'ONyc/USDC',
  targetHealthRate: 1.15,
  alertHealthRate: 1.10,
  emergencyHealthRate: 1.05,
  collDecimals: 9,  // ONyc has 9 decimals
  debtDecimals: 6,
  collNativeYield: 0.045,
  claimRewards: true,
  // No inputToken swap needed — depositing ONyc directly
};

async function main() {
  const rpcUrl = process.env.HELIUS_RPC_URL!;
  const wallet = loadWalletFromEnv();
  const walletAddress = process.env.SOLANA_WALLET_ADDRESS || wallet.publicKey;

  console.log('=== ONyc/USDC Multiply Deposit ===');
  console.log(`Wallet:  ${walletAddress}`);
  console.log(`Amount:  ${DEPOSIT_AMOUNT} ONyc (~$50)`);
  console.log(`Health:  >= 1.15`);
  console.log('');

  const adapter = new KaminoMultiplyLending(walletAddress, config, rpcUrl, wallet.secretKey);

  // Pre-check: leverage and APY
  const leverage = await adapter.getTargetLeverage();
  const apy = await adapter.getApy();
  console.log(`Target Leverage: ${leverage.toFixed(2)}x`);
  console.log(`Estimated APY:   ${(apy * 100).toFixed(2)}%`);
  console.log('');

  // Execute deposit
  console.log('Executing deposit...');
  const startTime = Date.now();

  try {
    const txSig = await adapter.deposit(DEPOSIT_AMOUNT);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDeposit tx: ${txSig}`);
    console.log(`Time: ${elapsed}s`);

    // Post-check: health and balance
    const health = await adapter.getHealthRate();
    const balance = await adapter.getBalance();
    console.log(`\nHealth Rate: ${health === Infinity ? 'N/A' : health.toFixed(4)}`);
    console.log(`Net Balance: $${balance.toFixed(2)}`);
    console.log('\nDone.');
  } catch (err) {
    console.error('\nDeposit failed:', (err as Error).message);
    console.error((err as Error).stack);
    process.exit(1);
  }
}

main().catch(console.error);
