import WebSocket from 'ws';
import { createChildLogger } from '../../utils/logger.js';
import type { BulkSubscribeMessage, BulkTickerData, BulkWsMessage } from './types.js';

const log = createChildLogger('bulk-ws');

const WS_URL = 'wss://exchange-ws1.bulk.trade';

// Reconnect backoff: starts at 1s, doubles each attempt, caps at 30s
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class BulkWsClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private stopped = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private markPriceCallback: ((price: number) => void) | null = null;
  private readonly symbol: string;

  constructor(symbol: string) {
    // symbol expected in Bulk format: 'SOL-USD'
    this.symbol = symbol;
  }

  onMarkPrice(cb: (price: number) => void): void {
    this.markPriceCallback = cb;
  }

  connect(): void {
    if (this.stopped) return;

    log.info({ symbol: this.symbol, url: WS_URL }, 'Connecting to Bulk WebSocket');
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      log.info('Bulk WebSocket connected');
      this.reconnectDelay = RECONNECT_INITIAL_MS;

      // Subscribe to ticker stream for mark price
      const subMsg: BulkSubscribeMessage = {
        method: 'subscribe',
        subscription: [{ type: 'ticker', symbol: this.symbol }],
      };
      this.ws!.send(JSON.stringify(subMsg));

      // Bulk server sends WebSocket-level pings every 30s; respond with pong.
      // The ws library handles this automatically (ws.on('ping') auto-pongs by default).
      // Set up a periodic keepalive check to detect stale connections.
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 20_000);
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as BulkWsMessage;
        this.handleMessage(msg);
      } catch {
        // ignore malformed messages
      }
    });

    this.ws.on('close', (code, reason) => {
      log.warn({ code, reason: reason.toString() }, 'Bulk WebSocket closed');
      this.clearPingTimer();
      if (!this.stopped) this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      log.error({ err: err.message }, 'Bulk WebSocket error');
      // 'close' event will follow — reconnect is handled there
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.clearPingTimer();
    this.ws?.close();
    this.ws = null;
  }

  private handleMessage(msg: BulkWsMessage): void {
    // Subscription confirmation
    if (msg.type === 'subscriptionResponse') {
      log.debug({ data: msg.data }, 'Bulk WS subscription confirmed');
      return;
    }

    // Ticker update
    if (msg.type === 'ticker' && msg.data) {
      const ticker = msg.data as BulkTickerData;
      const price = ticker.fairPrice ?? ticker.markPx;
      if (price && price > 0 && this.markPriceCallback) {
        this.markPriceCallback(price);
      }
    }
  }

  private scheduleReconnect(): void {
    log.info({ delayMs: this.reconnectDelay }, 'Scheduling Bulk WebSocket reconnect');
    setTimeout(() => {
      if (!this.stopped) this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
