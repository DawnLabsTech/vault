/**
 * Read ONyc native yield (APY) from the Onre Finance Solana program.
 *
 * The program stores Offer accounts (PDA seeds: ["offer", tokenInMint, tokenOutMint])
 * containing OfferVector entries with APR, base price, and timing data.
 *
 * Program ID: onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe
 * Scale: APR is u64 with scale=6 (1_000_000 = 100%)
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';

const log = createChildLogger('onre-apy');

const ONRE_PROGRAM_ID = new PublicKey('onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe');

// Well-known stablecoin mints used as tokenIn for ONyc offers
const STABLE_MINTS = [
  new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC
  new PublicKey('2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'), // USDG
];

interface OfferVector {
  startTime: number;
  baseTime: number;
  basePrice: number; // raw u64, scale=9
  apr: number;       // raw u64, scale=6 (1_000_000 = 100%)
  priceFix: number;  // seconds
}

function parseOfferVectors(data: Buffer): OfferVector[] {
  const vectors: OfferVector[] = [];
  // Account layout: 8 (discriminator) + 32 (tokenIn) + 32 (tokenOut) + 10 * 40 (vectors)
  for (let i = 0; i < 10; i++) {
    const offset = 72 + i * 40;
    if (offset + 40 > data.length) break;
    vectors.push({
      startTime: Number(data.readBigUInt64LE(offset)),
      baseTime: Number(data.readBigUInt64LE(offset + 8)),
      basePrice: Number(data.readBigUInt64LE(offset + 16)),
      apr: Number(data.readBigUInt64LE(offset + 24)),
      priceFix: Number(data.readBigUInt64LE(offset + 32)),
    });
  }
  return vectors;
}

function getActiveVector(vectors: OfferVector[], now: number): OfferVector | null {
  let active: OfferVector | null = null;
  for (const v of vectors) {
    if (v.startTime === 0 && v.baseTime === 0 && v.apr === 0) continue;
    if (v.startTime <= now) {
      if (!active || v.startTime > active.startTime) {
        active = v;
      }
    }
  }
  return active;
}

/** Convert APR (scale=6) to APY using daily compounding: (1 + apr/365)^365 - 1 */
function aprToApy(aprScale6: number): number {
  const aprDecimal = aprScale6 / 1_000_000;
  return Math.pow(1 + aprDecimal / 365, 365) - 1;
}

/**
 * Fetch ONyc's current native APY from the Onre program on-chain.
 *
 * Tries multiple stablecoin Offer PDAs (USDC, USDG) and returns the first successful result.
 * Falls back to the provided fallback value if all reads fail.
 *
 * @param rpcUrl - Solana RPC URL
 * @param onycMint - ONyc token mint address
 * @param fallback - Fallback APY (decimal, e.g. 0.10 = 10%) if on-chain read fails
 * @returns APY as decimal (e.g. 0.1025 = 10.25%)
 */
export async function getOnycApy(
  rpcUrl: string,
  onycMint: string,
  fallback: number = 0,
): Promise<{
  apy: number;
  apr: number;
  source: 'onchain' | 'fallback';
  basePrice?: number;
  tokenInMint?: string;
}> {
  return withRetry(async () => {
    const conn = new Connection(rpcUrl, 'confirmed');
    let onycPubkey: PublicKey;
    try {
      onycPubkey = new PublicKey(onycMint);
    } catch {
      log.warn({ onycMint }, 'Invalid ONyc mint address, using fallback');
      return { apy: fallback, apr: fallback, source: 'fallback' as const };
    }
    const now = Math.floor(Date.now() / 1000);

    for (const stableMint of STABLE_MINTS) {
      try {
        const [offerPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('offer'), stableMint.toBuffer(), onycPubkey.toBuffer()],
          ONRE_PROGRAM_ID,
        );

        const info = await conn.getAccountInfo(offerPda);
        if (!info || info.data.length < 472) continue;

        const vectors = parseOfferVectors(info.data);
        const active = getActiveVector(vectors, now);

        if (active && active.apr > 0) {
          const aprDecimal = active.apr / 1_000_000;
          const apyDecimal = aprToApy(active.apr);

          log.debug(
            {
              stableMint: stableMint.toBase58().slice(0, 8),
              apr: (aprDecimal * 100).toFixed(4),
              apy: (apyDecimal * 100).toFixed(4),
              basePrice: (active.basePrice / 1e9).toFixed(6),
            },
            'ONyc APY fetched from on-chain',
          );

          return {
            apy: apyDecimal,
            apr: aprDecimal,
            source: 'onchain' as const,
            basePrice: active.basePrice / 1e9,
            tokenInMint: stableMint.toBase58(),
          };
        }
      } catch (err) {
        log.debug(
          { stableMint: stableMint.toBase58().slice(0, 8), error: (err as Error).message },
          'Failed to read Onre offer, trying next',
        );
      }
    }

    log.warn({ fallback }, 'All Onre offer reads failed, using fallback');
    return { apy: fallback, apr: fallback, source: 'fallback' as const };
  }, 'onre-apy');
}

/** ONyc mint address constant */
export const ONYC_MINT = '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5';

/**
 * Check if a given token mint is ONyc.
 */
export function isOnycToken(mint: string): boolean {
  return mint === ONYC_MINT;
}
