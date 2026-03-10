import { getDb } from './db.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('state-store');

let stmtGet: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;
let stmtSet: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;

function getGetStmt() {
  if (!stmtGet) {
    stmtGet = getDb().prepare('SELECT value FROM state_store WHERE key = ?');
  }
  return stmtGet;
}

function getSetStmt() {
  if (!stmtSet) {
    stmtSet = getDb().prepare(`
      INSERT INTO state_store (key, value, updated_at)
      VALUES (@key, @value, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updatedAt
    `);
  }
  return stmtSet;
}

export function getState(key: string): string | null {
  const row = getGetStmt().get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(key: string, value: string): void {
  const updatedAt = new Date().toISOString();
  getSetStmt().run({ key, value, updatedAt });
  log.debug({ key }, 'State updated');
}

export function getStateJson<T>(key: string): T | null {
  const raw = getState(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    log.warn({ key }, 'Failed to parse state JSON, returning null');
    return null;
  }
}

export function setStateJson(key: string, value: unknown): void {
  setState(key, JSON.stringify(value));
}
