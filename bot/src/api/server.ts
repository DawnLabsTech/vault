import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createChildLogger } from '../utils/logger.js';
import { getLatestSnapshot, getSnapshots } from '../measurement/snapshots.js';
import { getDailyPnlRange, getPerformanceSummary } from '../measurement/pnl.js';
import { getEvents } from '../measurement/events.js';
import { getStateJson } from '../measurement/state-store.js';
import { getDb } from '../measurement/db.js';
import { FrMonitor } from '../core/fr-monitor.js';
import type { BaseAllocator } from '../strategies/base-allocator.js';
import type { KaminoMultiplyLending } from '../connectors/defi/kamino-multiply.js';
import type { MarketScanner } from '../core/market-scanner.js';
import type { PerpExchange } from '../types.js';

const log = createChildLogger('api');

const DEFAULT_DAWNSOL_APY = 0.07; // 7% default until enough data

export class ApiServer {
  private server: ReturnType<typeof createServer> | null = null;
  private frMonitor: FrMonitor | null = null;
  private baseAllocator: BaseAllocator | null = null;
  private multiplyAdapters: KaminoMultiplyLending[] = [];
  private marketScanner: MarketScanner | null = null;
  private perpExchange: PerpExchange = 'binance';

  setFrMonitor(monitor: FrMonitor): void {
    this.frMonitor = monitor;
  }

  setBaseAllocator(allocator: BaseAllocator): void {
    this.baseAllocator = allocator;
  }

  setMultiplyAdapters(adapters: KaminoMultiplyLending[]): void {
    this.multiplyAdapters = adapters;
  }

  setMarketScanner(scanner: MarketScanner | null): void {
    this.marketScanner = scanner;
  }

  setPerpExchange(exchange: PerpExchange): void {
    this.perpExchange = exchange;
  }

  start(port: number = 3000): void {
    this.server = createServer(async (req, res) => {
      // Health check — no auth required (used by Docker healthcheck)
      const healthUrl = new URL(req.url || '/', `http://${req.headers.host}`);
      if (healthUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      // Auth check — require token in production
      const authHeader = req.headers.authorization;
      const expectedAuth = process.env.API_AUTH_TOKEN;
      if (!expectedAuth && process.env.NODE_ENV === 'production') {
        log.error('API_AUTH_TOKEN not set in production — rejecting all requests');
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server misconfigured' }));
        return;
      }
      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        await this.handleRequest(req, res);
      } catch (err) {
        log.error({ error: (err as Error).message, url: req.url }, 'API error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });

    this.server.listen(port, () => {
      log.info({ port }, 'API server started');
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    switch (path) {
      case '/api/status': {
        const snapshot = getLatestSnapshot();
        const state = getStateJson<any>('orchestrator');
        const json = {
          state: state?.botState || 'UNKNOWN',
          startedAt: state?.startedAt,
          snapshot,
          uptime: state?.startedAt
            ? Date.now() - new Date(state.startedAt).getTime()
            : 0,
        };
        this.sendJson(res, json);
        break;
      }

      case '/api/pnl': {
        const from = url.searchParams.get('from') || '2020-01-01';
        const to = url.searchParams.get('to') || new Date().toISOString().split('T')[0]!;
        const pnl = getDailyPnlRange(from, to);
        this.sendJson(res, pnl);
        break;
      }

      case '/api/performance': {
        const summary = getPerformanceSummary();
        this.sendJson(res, summary);
        break;
      }

      case '/api/events': {
        const limit = parseInt(url.searchParams.get('limit') || '100');
        const type = url.searchParams.get('type') || undefined;
        const events = getEvents({ limit, type: type as any });
        this.sendJson(res, events);
        break;
      }

      case '/api/snapshots': {
        const limit = parseInt(url.searchParams.get('limit') || '100');
        const from = url.searchParams.get('from') || undefined;
        const to = url.searchParams.get('to') || undefined;
        const snapshots = getSnapshots({ from, to, limit });
        this.sendJson(res, snapshots);
        break;
      }

      case '/api/fr': {
        const limit = parseInt(url.searchParams.get('limit') || '168'); // 7 days * 24h
        const history = this.frMonitor?.getFrHistory(limit) || [];
        this.sendJson(res, history);
        break;
      }

      case '/api/fr-history': {
        const months = parseInt(url.searchParams.get('months') || '3');
        const frHistory = await this.fetchFrHistory(months);
        this.sendJson(res, frHistory);
        break;
      }

      case '/api/config': {
        this.sendJson(res, { perpExchange: this.perpExchange });
        break;
      }

      case '/api/apys': {
        const apys = await this.getApys();
        this.sendJson(res, apys);
        break;
      }

      case '/api/multiply': {
        const multiplyData = await this.getMultiplyData();
        this.sendJson(res, multiplyData);
        break;
      }

      case '/': {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(this.getDashboardHtml());
        break;
      }

      default:
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private async getApys(): Promise<{ lending: { protocol: string; apy: number }[]; dawnsolApy: number }> {
    // Lending APYs
    const lending = this.baseAllocator
      ? await this.baseAllocator.getApyRanking()
      : [];

    // dawnSOL APY: calculate from snapshot price ratio over 7 days
    let dawnsolApy = DEFAULT_DAWNSOL_APY;
    try {
      const rows = getDb().prepare(`
        SELECT sol_price, dawnsol_price, timestamp
        FROM snapshots
        WHERE sol_price > 0 AND dawnsol_price > 0
        ORDER BY timestamp ASC
      `).all() as { sol_price: number; dawnsol_price: number; timestamp: string }[];

      if (rows.length >= 2) {
        const oldest = rows[0]!;
        const newest = rows[rows.length - 1]!;
        const oldRatio = oldest.dawnsol_price / oldest.sol_price;
        const newRatio = newest.dawnsol_price / newest.sol_price;
        const daysDiff = (new Date(newest.timestamp).getTime() - new Date(oldest.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        if (daysDiff >= 1 && oldRatio > 0) {
          const periodReturn = (newRatio - oldRatio) / oldRatio;
          dawnsolApy = periodReturn * (365 / daysDiff);
        }
      }
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to calculate dawnSOL APY');
    }

    return { lending, dawnsolApy };
  }

  private async getMultiplyData(): Promise<{
    positions: Array<{
      label: string;
      balance: number;
      healthRate: number;
      effectiveApy: number;
      leverage: number;
      targetHealthRate: number;
      alertHealthRate: number;
      emergencyHealthRate: number;
    }>;
    candidates: Array<{
      label: string;
      effectiveApy: number;
      adjustedApy: number;
      movingAvg: number | null;
      riskTier: number;
      active: boolean;
      capacity: { remaining: number; utilizationRatio: number } | null;
      riskAssessment: {
        compositeScore: number;
        dimensions: {
          pegStability: number;
          liquidityDepth: number;
          reserveUtilization: number;
          tvlProtocol: number;
          borrowRateVol: number;
          collateralType: number;
        };
        riskPenalty: number;
        targetHealthRate: number;
        maxPositionCap: number;
        alertLevel: string;
      } | null;
    }>;
  }> {
    const positions = [];
    for (const adapter of this.multiplyAdapters) {
      try {
        const [balance, healthRate, effectiveApy, leverage] = await Promise.all([
          adapter.getBalance(),
          adapter.getHealthRate(),
          adapter.getApy(),
          adapter.getTargetLeverage(),
        ]);
        const cfg = adapter.getMultiplyConfig();
        positions.push({
          label: cfg.label,
          balance,
          healthRate,
          effectiveApy,
          leverage,
          targetHealthRate: cfg.targetHealthRate,
          alertHealthRate: cfg.alertHealthRate,
          emergencyHealthRate: cfg.emergencyHealthRate,
        });
      } catch (err) {
        log.warn({ adapter: adapter.name, error: (err as Error).message }, 'Failed to get multiply position data');
      }
    }

    const activeLabels = new Set(positions.map((p) => p.label));
    const scannerData = this.marketScanner?.getLatestScans() ?? [];
    const candidates = scannerData.map((s) => ({
      label: s.label,
      effectiveApy: s.effectiveApy,
      adjustedApy: s.adjustedApy,
      movingAvg: s.movingAvg,
      riskTier: 0, // filled below
      active: activeLabels.has(s.label),
      capacity: s.capacity ? { remaining: s.capacity.remaining, utilizationRatio: s.capacity.utilizationRatio } : null,
      riskAssessment: s.riskAssessment ? {
        compositeScore: s.riskAssessment.compositeScore,
        dimensions: s.riskAssessment.dimensions,
        riskPenalty: s.riskAssessment.riskPenalty,
        targetHealthRate: s.riskAssessment.targetHealthRate,
        maxPositionCap: s.riskAssessment.maxPositionCap,
        alertLevel: s.riskAssessment.alertLevel,
      } : null,
    }));

    // Fill riskTier from config
    const config = (await import('../config.js')).getConfig();
    const candidateConfigs = config.kaminoMultiplyCandidates ?? [];
    for (const c of candidates) {
      const cfg = candidateConfigs.find((cc) => cc.label === c.label);
      c.riskTier = cfg?.riskTier ?? 2;
    }

    return { positions, candidates };
  }

  private async fetchFrHistory(months: number): Promise<Array<{
    symbol: string;
    fundingRate: number;
    fundingTime: number;
    markPrice?: number;
  }>> {
    const startTime = Date.now() - months * 30 * 24 * 60 * 60 * 1000;

    try {
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/fundingRate?symbol=SOLUSDC&startTime=${startTime}&limit=1000`,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as any[];
      return data.map((d: any) => ({
        symbol: d.symbol,
        fundingRate: parseFloat(d.fundingRate),
        fundingTime: d.fundingTime,
        markPrice: d.markPrice ? parseFloat(d.markPrice) : undefined,
      }));
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to fetch Binance FR history');
      return [];
    }
  }

  private sendJson(res: ServerResponse, data: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  private getDashboardHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vault Strategy Bot</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'SF Mono', monospace; background: #0a0a0a; color: #e0e0e0; padding: 20px; }
    h1 { color: #00ff88; margin-bottom: 20px; }
    h2 { color: #888; margin: 20px 0 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 2px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px; }
    .card h3 { color: #00ff88; font-size: 13px; margin-bottom: 12px; }
    .metric { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #222; }
    .metric:last-child { border-bottom: none; }
    .label { color: #888; }
    .value { color: #fff; font-weight: bold; }
    .positive { color: #00ff88; }
    .negative { color: #ff4444; }
    .state-badge { display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: bold; }
    .state-BASE_ONLY { background: #1a3a1a; color: #00ff88; }
    .state-BASE_DN { background: #3a3a1a; color: #ffaa00; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #888; padding: 8px; border-bottom: 1px solid #333; }
    td { padding: 8px; border-bottom: 1px solid #1a1a1a; }
    #refresh-timer { color: #555; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Vault Strategy Bot <span id="refresh-timer"></span></h1>

  <div class="grid" id="status-grid">
    <div class="card">
      <h3>Bot Status</h3>
      <div id="status-content">Loading...</div>
    </div>
    <div class="card">
      <h3>Portfolio</h3>
      <div id="portfolio-content">Loading...</div>
    </div>
    <div class="card">
      <h3>Performance</h3>
      <div id="performance-content">Loading...</div>
    </div>
  </div>

  <h2>Daily PnL (Last 30 Days)</h2>
  <div class="card">
    <table id="pnl-table">
      <thead>
        <tr><th>Date</th><th>NAV Start</th><th>NAV End</th><th>Return</th><th>Lending</th><th>Funding</th><th>Fees</th></tr>
      </thead>
      <tbody id="pnl-body"></tbody>
    </table>
  </div>

  <h2>Recent Events</h2>
  <div class="card">
    <table id="events-table">
      <thead>
        <tr><th>Time</th><th>Type</th><th>Asset</th><th>Amount</th><th>Protocol</th></tr>
      </thead>
      <tbody id="events-body"></tbody>
    </table>
  </div>

  <script>
    async function fetchJson(url) {
      const res = await fetch(url);
      return res.json();
    }

    function fmt(n, d=2) { return n != null ? Number(n).toFixed(d) : '-'; }
    function pctClass(n) { return n >= 0 ? 'positive' : 'negative'; }

    async function refresh() {
      try {
        const [status, perf, pnl, events] = await Promise.all([
          fetchJson('/api/status'),
          fetchJson('/api/performance'),
          fetchJson('/api/pnl?from=' + new Date(Date.now() - 30*86400000).toISOString().split('T')[0]),
          fetchJson('/api/events?limit=20'),
        ]);

        // Status
        const s = status.snapshot || {};
        document.getElementById('status-content').innerHTML =
          '<div class="metric"><span class="label">State</span><span class="state-badge state-' + (status.state||'') + '">' + (status.state||'N/A') + '</span></div>' +
          '<div class="metric"><span class="label">Uptime</span><span class="value">' + (status.uptime ? Math.floor(status.uptime/3600000) + 'h' : 'N/A') + '</span></div>';

        // Portfolio
        document.getElementById('portfolio-content').innerHTML =
          '<div class="metric"><span class="label">Total NAV</span><span class="value">$' + fmt(s.totalNavUsdc) + '</span></div>' +
          '<div class="metric"><span class="label">Lending</span><span class="value">$' + fmt(s.lendingBalance) + '</span></div>' +
          '<div class="metric"><span class="label">dawnSOL</span><span class="value">' + fmt(s.dawnsolBalance, 4) + ' ($' + fmt(s.dawnsolUsdcValue) + ')</span></div>' +
          '<div class="metric"><span class="label">Binance USDC</span><span class="value">$' + fmt(s.binanceUsdcBalance) + '</span></div>' +
          '<div class="metric"><span class="label">PERP PnL</span><span class="value ' + pctClass(s.binancePerpUnrealizedPnl) + '">$' + fmt(s.binancePerpUnrealizedPnl) + '</span></div>';

        // Performance
        document.getElementById('performance-content').innerHTML =
          '<div class="metric"><span class="label">Total Return</span><span class="value ' + pctClass(perf.totalReturn) + '">' + fmt(perf.totalReturn*100, 4) + '%</span></div>' +
          '<div class="metric"><span class="label">Annualized</span><span class="value">' + fmt(perf.annualizedReturn*100, 2) + '%</span></div>' +
          '<div class="metric"><span class="label">Sharpe Ratio</span><span class="value">' + fmt(perf.sharpeRatio, 2) + '</span></div>' +
          '<div class="metric"><span class="label">Max Drawdown</span><span class="value negative">' + fmt(perf.maxDrawdown*100, 4) + '%</span></div>' +
          '<div class="metric"><span class="label">Days</span><span class="value">' + (perf.totalDays||0) + '</span></div>';

        // PnL table
        const pnlBody = (pnl||[]).reverse().map(p =>
          '<tr><td>' + p.date + '</td><td>$' + fmt(p.startingNav) + '</td><td>$' + fmt(p.endingNav) + '</td>' +
          '<td class="' + pctClass(p.dailyReturn) + '">' + fmt(p.dailyReturn*100,4) + '%</td>' +
          '<td>$' + fmt(p.lendingInterest,4) + '</td><td>$' + fmt(p.fundingReceived-p.fundingPaid,4) + '</td>' +
          '<td class="negative">-$' + fmt(p.totalFees,4) + '</td></tr>'
        ).join('');
        document.getElementById('pnl-body').innerHTML = pnlBody || '<tr><td colspan="7" style="color:#555">No data</td></tr>';

        // Events table
        const evBody = (events||[]).map(e =>
          '<tr><td>' + new Date(e.timestamp).toLocaleString() + '</td><td>' + e.eventType + '</td>' +
          '<td>' + (e.asset||'') + '</td><td>' + fmt(e.amount,4) + '</td><td>' + (e.sourceProtocol||'') + '</td></tr>'
        ).join('');
        document.getElementById('events-body').innerHTML = evBody || '<tr><td colspan="5" style="color:#555">No events</td></tr>';

      } catch (err) {
        console.error('Refresh error:', err);
      }
    }

    refresh();
    setInterval(refresh, 30000);
    let countdown = 30;
    setInterval(() => {
      countdown = countdown <= 0 ? 30 : countdown - 1;
      document.getElementById('refresh-timer').textContent = '(refresh in ' + countdown + 's)';
    }, 1000);
  </script>
</body>
</html>`;
  }
}
