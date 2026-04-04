/**
 * Read ONyc APY directly from on-chain Onre program.
 * Run: npx tsx scripts/check-onyc-apy.ts
 */
import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';

const ONRE_PROGRAM_ID = new PublicKey('onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ONYC_MINT = new PublicKey('5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5');
const USDG_MINT = new PublicKey('2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH');

interface OfferVector {
  startTime: number;
  baseTime: number;
  basePrice: number; // scale=9
  apr: number;       // scale=6 (1_000_000 = 100%)
  priceFix: number;  // seconds
}

function parseOffer(data: Buffer): { vectors: OfferVector[]; feeBps: number } {
  const vectors: OfferVector[] = [];
  for (let i = 0; i < 10; i++) {
    const offset = 72 + i * 40; // 8 discriminator + 32 tokenIn + 32 tokenOut
    const startTime = Number(data.readBigUInt64LE(offset));
    const baseTime = Number(data.readBigUInt64LE(offset + 8));
    const basePrice = Number(data.readBigUInt64LE(offset + 16));
    const apr = Number(data.readBigUInt64LE(offset + 24));
    const priceFix = Number(data.readBigUInt64LE(offset + 32));
    vectors.push({ startTime, baseTime, basePrice, apr, priceFix });
  }
  const feeBps = data.readUInt16LE(472);
  return { vectors, feeBps };
}

function getActiveVector(vectors: OfferVector[], now: number): OfferVector | null {
  // Find the latest active vector (startTime <= now)
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

function aprToApy(aprScale6: number): number {
  const aprDecimal = aprScale6 / 1_000_000;
  return Math.pow(1 + aprDecimal / 365, 365) - 1;
}

async function main() {
  const conn = new Connection(process.env.HELIUS_RPC_URL!);
  const now = Math.floor(Date.now() / 1000);

  console.log('ONyc APY from Onre Solana Program');
  console.log(`Time: ${new Date().toISOString()}\n`);

  const pairs = [
    { label: 'USDC → ONyc', tokenIn: USDC_MINT, tokenOut: ONYC_MINT },
    { label: 'USDG → ONyc', tokenIn: USDG_MINT, tokenOut: ONYC_MINT },
  ];

  for (const pair of pairs) {
    console.log(`=== ${pair.label} ===`);

    const [offerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('offer'), pair.tokenIn.toBuffer(), pair.tokenOut.toBuffer()],
      ONRE_PROGRAM_ID,
    );
    console.log(`Offer PDA: ${offerPda.toBase58()}`);

    const info = await conn.getAccountInfo(offerPda);
    if (!info) {
      console.log('  Account not found\n');
      continue;
    }

    const { vectors, feeBps } = parseOffer(info.data);

    // Print all non-zero vectors
    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i]!;
      if (v.startTime === 0 && v.apr === 0) continue;
      const aprPct = (v.apr / 1_000_000) * 100;
      const apyPct = aprToApy(v.apr) * 100;
      const isActive = v.startTime <= now;
      console.log(`  Vector ${i}: APR=${aprPct.toFixed(4)}% APY=${apyPct.toFixed(4)}% price=${(v.basePrice/1e9).toFixed(6)} active=${isActive} start=${new Date(v.startTime*1000).toISOString()}`);
    }

    const active = getActiveVector(vectors, now);
    if (active) {
      const aprPct = (active.apr / 1_000_000) * 100;
      const apyPct = aprToApy(active.apr) * 100;
      console.log(`\n  >>> Active APR: ${aprPct.toFixed(4)}%`);
      console.log(`  >>> Active APY: ${apyPct.toFixed(4)}%`);
      console.log(`  >>> Base Price: $${(active.basePrice / 1e9).toFixed(6)}`);
      console.log(`  >>> Fix Duration: ${active.priceFix}s`);
    }

    console.log(`  Fee: ${feeBps} bps\n`);
  }
}

main().catch(console.error);
