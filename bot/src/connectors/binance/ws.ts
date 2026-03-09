import WebSocket from 'ws';
import { createChildLogger } from '../../utils/logger.js';
import type { WsMarkPriceUpdate } from './types.js';

const log = createChildLogger('binance-ws');

const FUTURES_WS_URLS = {
  prod: 'wss://fstream.binance.com/ws/',
  testnet: 'wss://fstream.binancefuture.com/ws/',
} as const;

const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

type FundingRateCallback = (data: { symbol: string; fundingRate: number; nextFundingTime: number; markPrice: number }) => void;
type MarkPriceCallback = (data: { symbol: string; markPrice: number; indexPrice: number; timestamp: number }) => void;
type ConnectionCallback = (state: 'connected' | 'disconnected' | 'reconnecting') => void;

export class BinanceWsClient {
  private readonly baseUrl: string;
  private readonly symbol: string;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;

  // Callbacks
  private fundingRateCallbacks: FundingRateCallback[] = [];
  private markPriceCallbacks: MarkPriceCallback[] = [];
  private connectionCallbacks: ConnectionCallback[] = [];

  constructor(symbol: string, testnet = false) {
    this.symbol = symbol.toLowerCase();
    this.baseUrl = testnet ? FUTURES_WS_URLS.testnet : FUTURES_WS_URLS.prod;
    log.info({ symbol: this.symbol, testnet, baseUrl: this.baseUrl }, 'Binance WS client initialized');
  }

  // ─── Public API ─────────────────────────────────────────

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      log.warn('WebSocket already connected or connecting');
      return;
    }

    this.intentionalClose = false;
    this.establishConnection();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
    log.info('WebSocket disconnected intentionally');
    this.emitConnectionState('disconnected');
  }

  onFundingRate(callback: FundingRateCallback): () => void {
    this.fundingRateCallbacks.push(callback);
    return () => {
      this.fundingRateCallbacks = this.fundingRateCallbacks.filter(cb => cb !== callback);
    };
  }

  onMarkPrice(callback: MarkPriceCallback): () => void {
    this.markPriceCallbacks.push(callback);
    return () => {
      this.markPriceCallbacks = this.markPriceCallbacks.filter(cb => cb !== callback);
    };
  }

  onConnectionStateChange(callback: ConnectionCallback): () => void {
    this.connectionCallbacks.push(callback);
    return () => {
      this.connectionCallbacks = this.connectionCallbacks.filter(cb => cb !== callback);
    };
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ─── Connection Management ─────────────────────────────

  private establishConnection(): void {
    // markPrice@1s gives mark price + funding rate every second
    const streamUrl = `${this.baseUrl}${this.symbol}@markPrice@1s`;
    log.info({ url: streamUrl }, 'Connecting to WebSocket');

    this.ws = new WebSocket(streamUrl);

    this.ws.on('open', () => {
      log.info({ symbol: this.symbol }, 'WebSocket connected');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.emitConnectionState('connected');
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(data);
    });

    this.ws.on('pong', () => {
      this.clearPongTimer();
    });

    this.ws.on('error', (err: Error) => {
      log.error({ error: err.message }, 'WebSocket error');
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      log.warn({ code, reason: reason.toString() }, 'WebSocket closed');
      this.stopHeartbeat();

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: WsMarkPriceUpdate;
    try {
      msg = JSON.parse(raw.toString()) as WsMarkPriceUpdate;
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to parse WS message');
      return;
    }

    if (msg.e !== 'markPriceUpdate') return;

    const markPrice = parseFloat(msg.p);
    const indexPrice = parseFloat(msg.i);
    const fundingRate = parseFloat(msg.r);
    const symbol = msg.s;
    const timestamp = msg.E;
    const nextFundingTime = msg.T;

    // Emit mark price to all subscribers
    for (const cb of this.markPriceCallbacks) {
      try {
        cb({ symbol, markPrice, indexPrice, timestamp });
      } catch (err) {
        log.error({ error: (err as Error).message }, 'Error in markPrice callback');
      }
    }

    // Emit funding rate to all subscribers
    for (const cb of this.fundingRateCallbacks) {
      try {
        cb({ symbol, fundingRate, nextFundingTime, markPrice });
      } catch (err) {
        log.error({ error: (err as Error).message }, 'Error in fundingRate callback');
      }
    }
  }

  // ─── Heartbeat ─────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      this.ws.ping();

      // Expect pong within PONG_TIMEOUT_MS
      this.pongTimer = setTimeout(() => {
        log.warn('Pong timeout - forcing reconnect');
        this.ws?.terminate();
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  // ─── Reconnection ─────────────────────────────────────

  private scheduleReconnect(): void {
    this.emitConnectionState('reconnecting');

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );

    // Add jitter: 50-100% of calculated delay
    const jitteredDelay = delay * (0.5 + Math.random() * 0.5);

    this.reconnectAttempts++;
    log.info({ attempt: this.reconnectAttempts, delayMs: Math.round(jitteredDelay) }, 'Scheduling reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.establishConnection();
    }, jitteredDelay);
  }

  // ─── Cleanup ───────────────────────────────────────────

  private cleanup(): void {
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }
  }

  private emitConnectionState(state: 'connected' | 'disconnected' | 'reconnecting'): void {
    for (const cb of this.connectionCallbacks) {
      try {
        cb(state);
      } catch (err) {
        log.error({ error: (err as Error).message }, 'Error in connection state callback');
      }
    }
  }
}
