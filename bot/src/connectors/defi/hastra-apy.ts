/**
 * Fetch PRIME native yield from Hastra POR API.
 *
 * Endpoint: GET https://hastra.io/hastra-pulse/public/api/v1/por
 * Returns demo_prime_card.current_rate as percentage (e.g. 7.66 = 7.66%).
 */
import { createChildLogger } from '../../utils/logger.js';
import { withRetry } from '../../utils/retry.js';

const log = createChildLogger('hastra-apy');

const HASTRA_POR_API = 'https://hastra.io/hastra-pulse/public/api/v1/por';

/** PRIME token mint on Solana */
export const PRIME_MINT = '3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7';

export function isPrimeToken(mint: string): boolean {
  return mint === PRIME_MINT;
}

/**
 * Fetch PRIME's current native APY from the Hastra POR API.
 *
 * @param fallback - Fallback APY (decimal, e.g. 0.08 = 8%) if API call fails
 * @returns APY as decimal (e.g. 0.0766 = 7.66%)
 */
export async function getPrimeApy(
  fallback: number = 0.08,
): Promise<{ apy: number; source: 'api' | 'fallback' }> {
  return withRetry(async () => {
    try {
      const res = await fetch(HASTRA_POR_API);
      if (!res.ok) throw new Error(`Hastra API ${res.status}`);

      const data = (await res.json()) as { demo_prime_card?: { current_rate?: string } };
      const rate = data.demo_prime_card?.current_rate;

      if (rate) {
        const apy = parseFloat(rate) / 100;
        log.debug({ apy: `${(apy * 100).toFixed(2)}%` }, 'PRIME native yield fetched');
        return { apy, source: 'api' as const };
      }

      log.warn('No current_rate in Hastra response, using fallback');
      return { apy: fallback, source: 'fallback' as const };
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Hastra API failed, using fallback');
      return { apy: fallback, source: 'fallback' as const };
    }
  }, 'hastra-apy');
}
