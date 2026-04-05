import { getDb } from './db.js';
import type { LedgerEvent, EventType } from '../types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('events');

// Prepared statement cache (lazily initialized)
let stmtInsert: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let stmtByTxHash: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;

function getInsertStmt() {
  if (!stmtInsert) {
    stmtInsert = getDb().prepare(`
      INSERT INTO events (timestamp, event_type, amount, asset, price, tx_hash, order_id, fee, fee_asset, source_protocol, metadata)
      VALUES (@timestamp, @eventType, @amount, @asset, @price, @txHash, @orderId, @fee, @feeAsset, @sourceProtocol, @metadata)
    `);
  }
  return stmtInsert;
}

function getTxHashStmt() {
  if (!stmtByTxHash) {
    stmtByTxHash = getDb().prepare('SELECT * FROM events WHERE tx_hash = ?');
  }
  return stmtByTxHash;
}

function eventToRow(event: LedgerEvent) {
  return {
    timestamp: event.timestamp,
    eventType: event.eventType,
    amount: event.amount,
    asset: event.asset,
    price: event.price ?? null,
    txHash: event.txHash ?? null,
    orderId: event.orderId ?? null,
    fee: event.fee ?? null,
    feeAsset: event.feeAsset ?? null,
    sourceProtocol: event.sourceProtocol ?? null,
    metadata: event.metadata ? JSON.stringify(event.metadata) : null,
  };
}

function rowToEvent(row: Record<string, unknown>): LedgerEvent {
  return {
    timestamp: row['timestamp'] as string,
    eventType: row['event_type'] as EventType,
    amount: row['amount'] as number,
    asset: row['asset'] as string,
    price: row['price'] as number | undefined,
    txHash: row['tx_hash'] as string | undefined,
    orderId: row['order_id'] as string | undefined,
    fee: row['fee'] as number | undefined,
    feeAsset: row['fee_asset'] as string | undefined,
    sourceProtocol: row['source_protocol'] as string | undefined,
    metadata: row['metadata'] ? JSON.parse(row['metadata'] as string) as Record<string, unknown> : undefined,
  };
}

export function recordEvent(event: LedgerEvent): void {
  const stmt = getInsertStmt();
  stmt.run(eventToRow(event));
  log.debug({ eventType: event.eventType, amount: event.amount, asset: event.asset }, 'Event recorded');
}

export interface GetEventsOptions {
  from?: string;
  to?: string;
  type?: EventType;
  limit?: number;
}

export function getEvents(opts: GetEventsOptions): LedgerEvent[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts.from) {
    conditions.push('timestamp >= @from');
    params['from'] = opts.from;
  }
  if (opts.to) {
    conditions.push('timestamp <= @to');
    params['to'] = opts.to;
  }
  if (opts.type) {
    conditions.push('event_type = @type');
    params['type'] = opts.type;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  if (opts.limit) {
    params['limit'] = opts.limit;
  }
  const limitClause = opts.limit ? 'LIMIT @limit' : '';

  const sql = `SELECT * FROM events ${where} ORDER BY timestamp ASC ${limitClause}`;
  const rows = getDb().prepare(sql).all(params) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

export function getEventsByTxHash(txHash: string): LedgerEvent[] {
  const rows = getTxHashStmt().all(txHash) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}
