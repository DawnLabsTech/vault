/**
 * Test Jito bundle deposit: 1 USDC into existing ONyc/USDC Multiply position.
 * Run: npx tsx scripts/test-jito-deposit.ts
 */
import 'dotenv/config';
import { KaminoMultiplyLending, type KaminoMultiplyConfig } from '../src/connectors/defi/kamino-multiply.js';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';

const config: KaminoMultiplyConfig = {
  market: '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8',
  collToken: '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5', // ONyc
  debtToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  label: 'ONyc/USDC',
  targetHealthRate: 1.15,
  alertHealthRate: 1.10,
  emergencyHealthRate: 1.05,
  collDecimals: 9,
  debtDecimals: 6,
  collNativeYield: 0.045,
  claimRewards: true,
  inputToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  inputDecimals: 6,
};

async function main() {
  const wallet = loadWalletFromEnv();
  const walletAddress = process.env.SOLANA_WALLET_ADDRESS || wallet.publicKey;

  console.log('=== Jito Bundle Deposit Test ===');
  console.log(`Wallet: ${walletAddress}`);
  console.log(`Amount: 1 USDC (test)`)
  console.log('');

  const adapter = new KaminoMultiplyLending(walletAddress, config, process.env.HELIUS_RPC_URL!, wallet.secretKey);

  // Pre-check
  const health = await adapter.getHealthRate();
  const balance = await adapter.getBalance();
  console.log(`Before: health=${health === Infinity ? 'N/A' : health.toFixed(4)} balance=$${balance.toFixed(2)}`);

  // Deposit 1 USDC — should trigger Jito bundle if tx too large
  console.log('\nDepositing 1 USDC...');
  try {
    const result = await adapter.deposit(1);
    console.log(`Result: ${result}`);

    const healthAfter = await adapter.getHealthRate();
    const balanceAfter = await adapter.getBalance();
    console.log(`After: health=${healthAfter === Infinity ? 'N/A' : healthAfter.toFixed(4)} balance=$${balanceAfter.toFixed(2)}`);
  } catch (err) {
    console.error('Deposit failed:', (err as Error).message);
    console.error((err as Error).stack);
  }
}

main().catch(console.error);
