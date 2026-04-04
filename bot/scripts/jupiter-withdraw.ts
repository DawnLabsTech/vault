import 'dotenv/config';
import { JupiterLending } from '../src/connectors/defi/jupiter-lend.js';
import { loadWalletFromEnv } from '../src/connectors/solana/wallet.js';

async function main() {
  const wallet = loadWalletFromEnv();
  const walletAddress = process.env.SOLANA_WALLET_ADDRESS!;
  const rpcUrl = process.env.HELIUS_RPC_URL!;

  const jup = new JupiterLending(walletAddress, rpcUrl, wallet.secretKey);

  const balance = await jup.getBalance();
  console.log(`Jupiter Lend balance: ${balance.toFixed(6)} USDC`);

  if (balance < 0.01) {
    console.log('No significant balance to withdraw.');
    return;
  }

  const action = process.argv[2];
  if (action !== '--execute') {
    console.log(`\nTo withdraw all, run: npx tsx scripts/jupiter-withdraw.ts --execute`);
    return;
  }

  console.log(`Withdrawing ${balance.toFixed(6)} USDC...`);
  const sig = await jup.withdraw(balance);
  console.log(`Withdraw tx: ${sig}`);
  console.log(`https://solscan.io/tx/${sig}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
