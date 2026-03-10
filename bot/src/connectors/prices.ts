import { createChildLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type { PriceData } from '../types.js';

const log = createChildLogger('prices');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DAWNSOL_MINT = 'dawnsLuqPDY2Erch6ogeaHpvBdBaAZKBMqfbRHqjmqN';

const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2';

/** Cache TTL in milliseconds */
const CACHE_TTL_MS = 60_000;

interface PriceCache {
  data: PriceData;
  fetchedAt: number;
}

interface JupiterPriceResponse {
  data: Record<
    string,
    {
      id: string;
      type: string;
      price: string;
    } | null
  >;
  timeTaken: number;
}

let priceCache: PriceCache | null = null;
let lastKnownPrices: PriceData | null = null;

/**
 * Fetch prices from Jupiter Price API v2.
 * Fetches both SOL and dawnSOL prices in a single request.
 */
async function fetchPricesFromJupiter(): Promise<PriceData> {
  const url = `${JUPITER_PRICE_API}?ids=${SOL_MINT},${DAWNSOL_MINT}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = process.env.JUPITER_API_KEY;
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown');
    throw new Error(`Jupiter Price API error: HTTP ${response.status} - ${text}`);
  }

  const json = (await response.json()) as JupiterPriceResponse;

  const solEntry = json.data[SOL_MINT];
  const dawnsolEntry = json.data[DAWNSOL_MINT];

  if (!solEntry || !solEntry.price) {
    throw new Error('SOL price not available from Jupiter');
  }

  const solPrice = parseFloat(solEntry.price);
  if (isNaN(solPrice) || solPrice <= 0) {
    throw new Error(`Invalid SOL price from Jupiter: ${solEntry.price}`);
  }

  // dawnSOL might not always be available
  let dawnsolPrice: number;
  if (dawnsolEntry && dawnsolEntry.price) {
    dawnsolPrice = parseFloat(dawnsolEntry.price);
    if (isNaN(dawnsolPrice) || dawnsolPrice <= 0) {
      log.warn({ raw: dawnsolEntry.price }, 'Invalid dawnSOL price, falling back');
      // Fallback: estimate dawnSOL as ~1.05x SOL (typical LST premium)
      dawnsolPrice = solPrice * 1.05;
    }
  } else {
    log.warn('dawnSOL price not available from Jupiter, estimating from SOL price');
    dawnsolPrice = solPrice * 1.05;
  }

  return {
    sol: solPrice,
    dawnsol: dawnsolPrice,
    timestamp: Date.now(),
  };
}

/**
 * Get SOL/USD price.
 * Uses cache if available and fresh, otherwise fetches from Jupiter.
 */
export async function getSolPrice(): Promise<number> {
  const prices = await getPrices();
  return prices.sol;
}

/**
 * Get dawnSOL/USD price.
 * Uses cache if available and fresh, otherwise fetches from Jupiter.
 */
export async function getDawnSolPrice(): Promise<number> {
  const prices = await getPrices();
  return prices.dawnsol;
}

/**
 * Get both SOL and dawnSOL prices.
 * Cached for 60 seconds. Falls back to last known prices on failure.
 */
export async function getPrices(): Promise<PriceData> {
  // Return cached if still fresh
  if (priceCache && Date.now() - priceCache.fetchedAt < CACHE_TTL_MS) {
    return priceCache.data;
  }

  try {
    const prices = await withRetry(
      () => fetchPricesFromJupiter(),
      'jupiter-prices',
      { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 5_000 },
    );

    priceCache = { data: prices, fetchedAt: Date.now() };
    lastKnownPrices = prices;

    log.debug(
      { sol: prices.sol, dawnsol: prices.dawnsol },
      'Prices fetched',
    );

    return prices;
  } catch (err) {
    // Fallback to last known prices
    if (lastKnownPrices) {
      const staleness = Date.now() - lastKnownPrices.timestamp;
      log.warn(
        { err, stalenessMs: staleness, sol: lastKnownPrices.sol, dawnsol: lastKnownPrices.dawnsol },
        'Price fetch failed, using stale prices',
      );
      return lastKnownPrices;
    }

    // No fallback available
    log.error({ err }, 'Price fetch failed and no fallback available');
    throw err;
  }
}

/**
 * Invalidate the price cache, forcing the next call to fetch fresh prices.
 */
export function invalidatePriceCache(): void {
  priceCache = null;
  log.debug('Price cache invalidated');
}

/**
 * Get the age of the current cached prices in milliseconds.
 * Returns null if no cache exists.
 */
export function getPriceCacheAge(): number | null {
  if (!priceCache) return null;
  return Date.now() - priceCache.fetchedAt;
}
