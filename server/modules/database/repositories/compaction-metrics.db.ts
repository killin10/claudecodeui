import { getConnection } from '@/modules/database/connection.js';

/** Database initialization installs provider-observed timings; session deletion cascades. */
export const COMPACTION_METRICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS compaction_metrics (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  duration_ms REAL NOT NULL CHECK(duration_ms >= 0),
  started_at TEXT NOT NULL,
  PRIMARY KEY(session_id, message_id)
);`;

/** OpenCode persists measured event durations because its native message omits them. */
export const compactionMetricsDb = {
  save(sessionId: string, messageId: string, durationMs: number, startedAt: string): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('Invalid compaction duration');
    getConnection().prepare(`INSERT INTO compaction_metrics(session_id, message_id, duration_ms, started_at)
      SELECT session_id, ?, ?, ? FROM sessions WHERE provider = 'opencode' AND (session_id = ? OR provider_session_id = ?)
      ON CONFLICT(session_id, message_id) DO UPDATE SET duration_ms = excluded.duration_ms, started_at = excluded.started_at`)
      .run(messageId, durationMs, startedAt, sessionId, sessionId);
  },
  list(sessionId: string): Map<string, { durationMs: number; startedAt: string }> {
    const db = getConnection();
    // Read-only provider tests and older, not-yet-migrated stores have no observations.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'compaction_metrics'").get()) return new Map();
    const rows = db.prepare(`SELECT m.message_id, m.duration_ms, m.started_at FROM compaction_metrics m
      JOIN sessions s USING(session_id) WHERE s.provider = 'opencode' AND (s.session_id = ? OR s.provider_session_id = ?)`)
      .all(sessionId, sessionId) as Array<{ message_id: string; duration_ms: number; started_at: string }>;
    return new Map(rows.map(row => [row.message_id, { durationMs: row.duration_ms, startedAt: row.started_at }]));
  },
};
