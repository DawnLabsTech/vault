import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OracleMonitor,
  type JupiterQuoteSource,
  type OracleMarketSource,
  type PythPriceSource,
} from '../../src/risk/oracle-monitor.js';

vi.mock('../../src/utils/notify.js', () => ({
  sendAlert: vi.fn(),
}));

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Arbitrary non-stable mints used as collateral in tests.
const ONYC = 'TEST_ONYC_MINT_111111111111111111111111111111';

interface FakePrices {
  collOracle: number;
  collStored: number;
  debtOracle: number;
  debtStored: number;
}

function makeMarket(label: string, prices: FakePrices, collMint = ONYC, debtMint = USDC): OracleMarketSource {
  return {
    label,
    getOraclePrices: async () => ({
      label,
      coll: { mint: collMint, decimals: 6, oracle: prices.collOracle, stored: prices.collStored },
      debt: { mint: debtMint, decimals: 6, oracle: prices.debtOracle, stored: prices.debtStored },
    }),
  };
}

function makeJupiter(price: number | null): JupiterQuoteSource {
  return {
    quotePrice: vi.fn(async () => price),
  };
}

function makePyth(reading: { price: number; confidence: number; publishTime: number } | null): PythPriceSource {
  return {
    getPrice: vi.fn(async () => reading),
  };
}

describe('OracleMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits no events when prices are healthy', async () => {
    const market = makeMarket('ONyc/USDC', {
      collOracle: 1.06, collStored: 1.06, debtOracle: 1.0001, debtStored: 1.0001,
    });
    const monitor = new OracleMonitor({
      markets: [market],
      jupiterQuote: makeJupiter(1.0598), // close to Kamino implied 1.0599
    });

    const events = await monitor.check();
    expect(events).toEqual([]);
  });

  it('flags USDC depeg as warning at >= 50bps', async () => {
    const market = makeMarket('ONyc/USDC', {
      collOracle: 1.06, collStored: 1.06, debtOracle: 0.994, debtStored: 0.994,
    });
    const monitor = new OracleMonitor({ markets: [market] });

    const events = await monitor.check();
    const depeg = events.find((e) => e.kind === 'stable-depeg');
    expect(depeg).toBeDefined();
    expect(depeg!.severity).toBe('warning');
    expect(depeg!.market).toBe('*');
  });

  it('escalates USDC depeg to critical only after sustained samples', async () => {
    const market = makeMarket('ONyc/USDC', {
      collOracle: 1.06, collStored: 1.06, debtOracle: 0.985, debtStored: 0.985,
    });
    const monitor = new OracleMonitor({
      markets: [market],
      config: { sustainedSamples: 3 },
    });

    // 1st sample: critical, not sustained
    const evs1 = await monitor.check();
    const c1 = evs1.find((e) => e.kind === 'stable-depeg');
    expect(c1?.severity).toBe('critical');
    expect(c1?.sustained).toBe(false);
    expect(c1?.consecutiveCount).toBe(1);

    // 2nd sample
    const evs2 = await monitor.check();
    const c2 = evs2.find((e) => e.kind === 'stable-depeg');
    expect(c2?.sustained).toBe(false);
    expect(c2?.consecutiveCount).toBe(2);

    // 3rd sample → sustained
    const evs3 = await monitor.check();
    const c3 = evs3.find((e) => e.kind === 'stable-depeg');
    expect(c3?.sustained).toBe(true);
    expect(c3?.consecutiveCount).toBe(3);
  });

  it('resets sustained counter when condition recovers', async () => {
    const market: OracleMarketSource = {
      label: 'ONyc/USDC',
      getOraclePrices: vi.fn()
        // 1st: critical
        .mockResolvedValueOnce({
          label: 'ONyc/USDC',
          coll: { mint: ONYC, decimals: 6, oracle: 1.06, stored: 1.06 },
          debt: { mint: USDC, decimals: 6, oracle: 0.985, stored: 0.985 },
        })
        // 2nd: recovered
        .mockResolvedValueOnce({
          label: 'ONyc/USDC',
          coll: { mint: ONYC, decimals: 6, oracle: 1.06, stored: 1.06 },
          debt: { mint: USDC, decimals: 6, oracle: 1.0001, stored: 1.0001 },
        })
        // 3rd: critical again
        .mockResolvedValueOnce({
          label: 'ONyc/USDC',
          coll: { mint: ONYC, decimals: 6, oracle: 1.06, stored: 1.06 },
          debt: { mint: USDC, decimals: 6, oracle: 0.985, stored: 0.985 },
        }),
    };
    const monitor = new OracleMonitor({
      markets: [market],
      config: { sustainedSamples: 3 },
    });

    const evs1 = await monitor.check();
    expect(evs1.find((e) => e.kind === 'stable-depeg')?.consecutiveCount).toBe(1);
    await monitor.check(); // recovered
    const evs3 = await monitor.check();
    // Counter resets after the recovery sample, so 3rd check should be count=1.
    expect(evs3.find((e) => e.kind === 'stable-depeg')?.consecutiveCount).toBe(1);
    expect(evs3.find((e) => e.kind === 'stable-depeg')?.sustained).toBe(false);
  });

  it('flags ONyc oracle over-pricing critical at >= overpriceCriticalBps', async () => {
    // Kamino implied: 1.10/1.0001 ≈ 1.0999 USDC per ONyc
    // Jupiter says: 1.06 USDC per ONyc
    // Overprice: (1.0999 - 1.06)/1.06 ≈ 376 bps → critical
    const market = makeMarket('ONyc/USDC', {
      collOracle: 1.10, collStored: 1.10, debtOracle: 1.0001, debtStored: 1.0001,
    });
    const monitor = new OracleMonitor({
      markets: [market],
      jupiterQuote: makeJupiter(1.06),
      config: { sustainedSamples: 1 }, // immediate sustained
    });

    const events = await monitor.check();
    const cross = events.find((e) => e.kind === 'cross-source-dev');
    expect(cross).toBeDefined();
    expect(cross!.severity).toBe('critical');
    expect(cross!.sustained).toBe(true);
    expect(cross!.data['direction']).toBe('kamino-over-dex');
  });

  it('emits cross-source warning at >= warnBps but < criticalBps', async () => {
    // Kamino implied 1.06; Jupiter 1.0540 → ~57 bps
    const market = makeMarket('ONyc/USDC', {
      collOracle: 1.06, collStored: 1.06, debtOracle: 1.0, debtStored: 1.0,
    });
    const monitor = new OracleMonitor({
      markets: [market],
      jupiterQuote: makeJupiter(1.054),
      config: {
        onycCrossSourceWarnBps: 50,
        onycCrossSourceCriticalBps: 100,
        onycOverpriceCriticalBps: 75, // direction critical at 75
      },
    });

    const events = await monitor.check();
    const cross = events.find((e) => e.kind === 'cross-source-dev');
    // 57 bps is below 75 overprice critical, below 100 absolute critical, above 50 warn.
    expect(cross?.severity).toBe('warning');
  });

  it('skips cross-source when no Jupiter source is wired', async () => {
    const market = makeMarket('ONyc/USDC', {
      collOracle: 1.10, collStored: 1.10, debtOracle: 1.0, debtStored: 1.0,
    });
    const monitor = new OracleMonitor({ markets: [market] /* no jupiter */ });

    const events = await monitor.check();
    expect(events.find((e) => e.kind === 'cross-source-dev')).toBeUndefined();
  });

  it('does not reset sustained counter on Jupiter quote failure', async () => {
    const market = makeMarket('ONyc/USDC', {
      collOracle: 1.10, collStored: 1.10, debtOracle: 1.0, debtStored: 1.0,
    });
    const calls: Array<number | null> = [1.06, null, 1.06];
    const jupiter: JupiterQuoteSource = {
      quotePrice: vi.fn(async () => {
        const v = calls.shift();
        return v === undefined ? null : v;
      }),
    };
    const monitor = new OracleMonitor({
      markets: [market],
      jupiterQuote: jupiter,
      config: { sustainedSamples: 3 },
    });

    const evs1 = await monitor.check();
    expect(evs1.find((e) => e.kind === 'cross-source-dev')?.consecutiveCount).toBe(1);

    // Quote fails — no event, but counter must NOT reset.
    const evs2 = await monitor.check();
    expect(evs2.find((e) => e.kind === 'cross-source-dev')).toBeUndefined();

    // 3rd sample (back to critical): count should be 2 (preserved across failure).
    const evs3 = await monitor.check();
    expect(evs3.find((e) => e.kind === 'cross-source-dev')?.consecutiveCount).toBe(2);
  });

  it('flags Kamino stored-vs-oracle delta as warning', async () => {
    const market = makeMarket('ONyc/USDC', {
      collOracle: 1.10, // moved
      collStored: 1.06, // not yet refreshed → ~377 bps delta
      debtOracle: 1.0,
      debtStored: 1.0,
    });
    const monitor = new OracleMonitor({ markets: [market] });
    const events = await monitor.check();
    const stale = events.find((e) => e.kind === 'kamino-stale');
    expect(stale).toBeDefined();
    expect(stale!.severity).toBe('warning');
  });

  it('flags Pyth staleness when publishTime is too old', async () => {
    const market = makeMarket('ONyc/USDC', {
      collOracle: 1.06, collStored: 1.06, debtOracle: 1.0001, debtStored: 1.0001,
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const pyth = makePyth({ price: 1.06, confidence: 0.001, publishTime: nowSec - 600 });
    const monitor = new OracleMonitor({
      markets: [market],
      pythSource: pyth,
      pythPriceIds: { [ONYC]: '0xdeadbeef' },
      config: { pythStalenessSec: 60 },
    });

    const events = await monitor.check();
    const stale = events.find((e) => e.kind === 'pyth-stale');
    expect(stale).toBeDefined();
    expect(stale!.severity).toBe('warning');
  });

  it('flags Pyth wide confidence interval', async () => {
    const market = makeMarket('ONyc/USDC', {
      collOracle: 1.06, collStored: 1.06, debtOracle: 1.0001, debtStored: 1.0001,
    });
    const pyth = makePyth({
      price: 1.06,
      confidence: 0.05, // ~4.7% of price → above default 1%
      publishTime: Math.floor(Date.now() / 1000),
    });
    const monitor = new OracleMonitor({
      markets: [market],
      pythSource: pyth,
      pythPriceIds: { [ONYC]: '0xdeadbeef' },
    });

    const events = await monitor.check();
    const conf = events.find((e) => e.kind === 'pyth-confidence');
    expect(conf).toBeDefined();
    expect(conf!.severity).toBe('warning');
  });

  it('skips Pyth checks when no priceId is configured', async () => {
    const market = makeMarket('ONyc/USDC', {
      collOracle: 1.06, collStored: 1.06, debtOracle: 1.0001, debtStored: 1.0001,
    });
    const pyth = makePyth({ price: 99, confidence: 50, publishTime: 0 }); // intentionally bad
    const monitor = new OracleMonitor({
      markets: [market],
      pythSource: pyth,
      pythPriceIds: {}, // no ids
    });

    const events = await monitor.check();
    expect(events.find((e) => e.kind?.startsWith('pyth-'))).toBeUndefined();
  });
});
