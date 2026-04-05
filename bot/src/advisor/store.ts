import type Database from 'better-sqlite3';
import type { AdvisorRecommendation } from './types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('advisor-store');

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS advisor_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    confidence TEXT NOT NULL,
    urgency TEXT NOT NULL,
    current_rule TEXT NOT NULL,
    override INTEGER NOT NULL DEFAULT 0,
    context_json TEXT,
    outcome TEXT,
    outcome_notes TEXT
  )
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_advisor_timestamp ON advisor_recommendations(timestamp);
  CREATE INDEX IF NOT EXISTS idx_advisor_category ON advisor_recommendations(category);
`;

export class AdvisorStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    db.exec(CREATE_TABLE_SQL);
    db.exec(CREATE_INDEX_SQL);

    this.insertStmt = db.prepare(`
      INSERT INTO advisor_recommendations (
        timestamp, category, action, reasoning, confidence, urgency,
        current_rule, override, context_json
      ) VALUES (
        @timestamp, @category, @action, @reasoning, @confidence, @urgency,
        @currentRule, @override, @contextJson
      )
    `);

    log.info('Advisor store initialized');
  }

  save(rec: AdvisorRecommendation, contextJson?: string): number {
    const result = this.insertStmt.run({
      timestamp: rec.timestamp,
      category: rec.category,
      action: rec.action,
      reasoning: rec.reasoning,
      confidence: rec.confidence,
      urgency: rec.urgency,
      currentRule: rec.currentRule,
      override: rec.override ? 1 : 0,
      contextJson: contextJson ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getRecent(limit = 20): AdvisorRecommendation[] {
    const rows = this.db
      .prepare('SELECT * FROM advisor_recommendations ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToRecommendation);
  }

  getByCategory(category: string, limit = 10): AdvisorRecommendation[] {
    const rows = this.db
      .prepare('SELECT * FROM advisor_recommendations WHERE category = ? ORDER BY timestamp DESC LIMIT ?')
      .all(category, limit) as Record<string, unknown>[];
    return rows.map(rowToRecommendation);
  }

  /** Update outcome for a past recommendation (for accuracy tracking) */
  setOutcome(id: number, outcome: 'correct' | 'incorrect' | 'neutral', notes?: string): void {
    this.db
      .prepare('UPDATE advisor_recommendations SET outcome = ?, outcome_notes = ? WHERE id = ?')
      .run(outcome, notes ?? null, id);
  }

  /** Get accuracy stats for a time window */
  getAccuracyStats(fromTimestamp: number): { total: number; correct: number; incorrect: number; neutral: number; pending: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END) as correct,
        SUM(CASE WHEN outcome = 'incorrect' THEN 1 ELSE 0 END) as incorrect,
        SUM(CASE WHEN outcome = 'neutral' THEN 1 ELSE 0 END) as neutral,
        SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) as pending
      FROM advisor_recommendations
      WHERE timestamp >= ?
    `).get(fromTimestamp) as Record<string, number>;

    return {
      total: row['total'] ?? 0,
      correct: row['correct'] ?? 0,
      incorrect: row['incorrect'] ?? 0,
      neutral: row['neutral'] ?? 0,
      pending: row['pending'] ?? 0,
    };
  }
}

function rowToRecommendation(row: Record<string, unknown>): AdvisorRecommendation {
  return {
    timestamp: row['timestamp'] as number,
    category: row['category'] as AdvisorRecommendation['category'],
    action: row['action'] as string,
    reasoning: row['reasoning'] as string,
    confidence: row['confidence'] as AdvisorRecommendation['confidence'],
    urgency: row['urgency'] as AdvisorRecommendation['urgency'],
    currentRule: row['current_rule'] as string,
    override: (row['override'] as number) === 1,
  };
}
