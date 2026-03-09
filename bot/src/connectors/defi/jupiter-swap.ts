import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';
import type { SwapQuote, SwapResult } from './types.js';
import { MINTS } from './types.js';

const log = createChildLogger('jupiter-swap');

const JUPITER_API = 'https://quote-api.jup.ag/v6';

export class JupiterSwap {
  private walletAddress: string;

  constructor(walletAddress: string) {
    this.walletAddress = walletAddress;
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number, // in base units (lamports for SOL, smallest unit for tokens)
    slippageBps: number = 50,
  ): Promise<SwapQuote> {
    return withRetry(async () => {
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: slippageBps.toString(),
      });

      const res = await fetch(`${JUPITER_API}/quote?${params}`);
      if (!res.ok) {
        throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
      }

      const data = await res.json() as any;
      return {
        inputMint,
        outputMint,
        inputAmount: Number(data.inAmount),
        outputAmount: Number(data.outAmount),
        priceImpactPct: Number(data.priceImpactPct),
        slippageBps,
        routePlan: JSON.stringify(data.routePlan),
      };
    }, 'jupiter-quote');
  }

  async getSwapTransaction(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50,
  ): Promise<{ swapTransaction: string; quote: SwapQuote }> {
    const quote = await this.getQuote(inputMint, outputMint, amount, slippageBps);

    const res = await fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.walletAddress,
        wrapAndUnwrapSol: true,
      }),
    });

    if (!res.ok) {
      throw new Error(`Jupiter swap tx failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as any;
    return {
      swapTransaction: data.swapTransaction,
      quote,
    };
  }

  // Convenience methods
  async quoteSolToDawnSol(solAmount: number, slippageBps = 50): Promise<SwapQuote> {
    const lamports = Math.floor(solAmount * 1e9);
    return this.getQuote(MINTS.SOL, MINTS.DAWNSOL, lamports, slippageBps);
  }

  async quoteDawnSolToSol(dawnsolAmount: number, slippageBps = 50): Promise<SwapQuote> {
    // dawnSOL has 9 decimals like SOL
    const baseUnits = Math.floor(dawnsolAmount * 1e9);
    return this.getQuote(MINTS.DAWNSOL, MINTS.SOL, baseUnits, slippageBps);
  }

  async quoteUsdcToSol(usdcAmount: number, slippageBps = 50): Promise<SwapQuote> {
    // USDC has 6 decimals
    const baseUnits = Math.floor(usdcAmount * 1e6);
    return this.getQuote(MINTS.USDC, MINTS.SOL, baseUnits, slippageBps);
  }

  async quoteSolToUsdc(solAmount: number, slippageBps = 50): Promise<SwapQuote> {
    const lamports = Math.floor(solAmount * 1e9);
    return this.getQuote(MINTS.SOL, MINTS.USDC, lamports, slippageBps);
  }
}
