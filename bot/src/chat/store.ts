import type Database from 'better-sqlite3';
import type { ChatMessage } from './types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('chat-store');

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    metadata_json TEXT
  )
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_chat_session_ts ON chat_messages(session_id, timestamp);
`;

export class ChatStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    db.exec(CREATE_TABLE_SQL);
    db.exec(CREATE_INDEX_SQL);

    this.insertStmt = db.prepare(`
      INSERT INTO chat_messages (id, session_id, role, content, timestamp, metadata_json)
      VALUES (@id, @sessionId, @role, @content, @timestamp, @metadataJson)
    `);

    log.info('Chat store initialized');
  }

  save(msg: ChatMessage): void {
    this.insertStmt.run({
      id: msg.id,
      sessionId: msg.sessionId,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      metadataJson: msg.metadata ? JSON.stringify(msg.metadata) : null,
    });
  }

  getHistory(sessionId: string, limit = 20): ChatMessage[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?',
      )
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(rowToMessage).reverse();
  }

  countRecent(sessionId: string, sinceMs: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) as cnt FROM chat_messages WHERE session_id = ? AND role = ? AND timestamp >= ?',
      )
      .get(sessionId, 'user', sinceMs) as { cnt: number };
    return row.cnt;
  }

  countAllRecent(sinceMs: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) as cnt FROM chat_messages WHERE role = ? AND timestamp >= ?',
      )
      .get('user', sinceMs) as { cnt: number };
    return row.cnt;
  }
}

function rowToMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row['id'] as string,
    sessionId: row['session_id'] as string,
    role: row['role'] as ChatMessage['role'],
    content: row['content'] as string,
    timestamp: row['timestamp'] as number,
    metadata: row['metadata_json']
      ? (JSON.parse(row['metadata_json'] as string) as ChatMessage['metadata'])
      : undefined,
  };
}
