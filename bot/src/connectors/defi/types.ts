export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  priceImpactPct: number;
  slippageBps: number;
  routePlan: string;
}

export interface SwapResult {
  txSig: string;
  inputAmount: number;
  outputAmount: number;
  priceImpactPct: number;
}

// Well-known Solana token mints
export const MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  DAWNSOL: 'dawnsLuqPDY2Erch6ogeaHpvBdBaAZKBMqfbRHqjmqN',
} as const;
