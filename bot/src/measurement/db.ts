import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('db');

const DB_DIR = join(process.cwd(), 'data');
const DB_PATH = join(DB_DIR, 'vault.db');

let db: Database.Database | null = null;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    amount REAL,
    asset TEXT,
    price REAL,
    tx_hash TEXT,
    order_id TEXT,
    fee REAL,
    fee_asset TEXT,
    source_protocol TEXT,
    metadata TEXT
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    total_nav_usdc REAL NOT NULL,
    lending_balance REAL,
    lending_breakdown TEXT,
    dawnsol_balance REAL,
    dawnsol_usdc_value REAL,
    binance_usdc_balance REAL,
    buffer_usdc_balance REAL,
    binance_perp_unrealized_pnl REAL,
    binance_perp_size REAL,
    state TEXT NOT NULL,
    sol_price REAL,
    dawnsol_price REAL
  );

  CREATE TABLE IF NOT EXISTS daily_pnl (
    date TEXT PRIMARY KEY,
    starting_nav REAL,
    ending_nav REAL,
    daily_return REAL,
    cumulative_return REAL,
    realized_pnl REAL,
    unrealized_pnl REAL,
    lending_interest REAL,
    funding_received REAL,
    funding_paid REAL,
    staking_accrual REAL,
    swap_pnl REAL,
    binance_trading_fee REAL,
    binance_withdraw_fee REAL,
    solana_gas REAL,
    swap_slippage REAL,
    lending_fee REAL,
    total_fees REAL,
    nav_high REAL,
    nav_low REAL,
    max_drawdown REAL
  );

  CREATE TABLE IF NOT EXISTS fr_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    symbol TEXT NOT NULL,
    funding_rate REAL NOT NULL,
    annualized_rate REAL NOT NULL,
    mark_price REAL
  );

  CREATE TABLE IF NOT EXISTS state_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_tx_hash ON events(tx_hash);
  CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp);
  CREATE INDEX IF NOT EXISTS idx_fr_history_timestamp ON fr_history(timestamp);
  CREATE INDEX IF NOT EXISTS idx_fr_history_symbol ON fr_history(symbol);
`;

export function initDb(): Database.Database {
  mkdirSync(DB_DIR, { recursive: true });

  const database = new Database(DB_PATH);
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('foreign_keys = ON');

  database.exec(SCHEMA_SQL);

  // Migrate: add buffer_usdc_balance column for existing databases
  try {
    database.exec('ALTER TABLE snapshots ADD COLUMN buffer_usdc_balance REAL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }

  log.info({ path: DB_PATH }, 'Database initialized');
  return database;
}

export function getDb(): Database.Database {
  if (!db) {
    db = initDb();
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    log.info('Database closed');
  }
}
