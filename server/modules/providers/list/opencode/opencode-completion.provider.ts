import type Database from 'better-sqlite3';

/** Background reconciliation reads native execution generations; history uses the terminal-only wrapper.
 * A persisted idle is valid only for the current execution, never a previous run.
 * Read failures propagate; absence of evidence is not evidence of completion.
 */
export function readOpenCodeExecution(db: Database.Database, sessionId: string, startedAt: number) {
  const row = db.prepare(`SELECT time_busy, time_idle, idle_outcome FROM session_v2 WHERE id = ?`)
    .get(sessionId) as { time_busy: number | null; time_idle: number | null; idle_outcome: string | null } | undefined;
  if (!row || typeof row.time_busy !== 'number' || (!Number.isFinite(startedAt) || startedAt <= 0)) return undefined;
  if (row.time_idle === null || row.time_idle < row.time_busy) {
    return { status: 'running' as const, at: row.time_busy };
  }
  if (typeof row.time_idle !== 'number' || row.time_idle < startedAt) return undefined;
  switch (row.idle_outcome) {
    case 'succeeded': return { status: 'completed' as const, at: row.time_idle };
    case 'failed': return { status: 'failed' as const, at: row.time_idle };
    case 'interrupted': return { status: 'stopped' as const, at: row.time_idle };
    default: return undefined;
  }
}

/** History and runtime cleanup require a confirmed terminal execution, not a busy marker. */
export function readOpenCodeCompletion(db: Database.Database, sessionId: string, startedAt: number) {
  const execution = readOpenCodeExecution(db, sessionId, startedAt);
  return execution?.status === 'running' ? undefined : execution;
}

/** Background reconciliation uses the persisted delivery, including after a host restart. */
export function readOpenCodeDelivery(db: Database.Database, childId: string, startedAt: number) {
  return db.prepare(`SELECT m.session_id AS parentId, json_extract(m.data, '$.time.created') AS at
    FROM session_message m JOIN session_v2 child ON child.parent_id = m.session_id
    WHERE child.id = ? AND m.type = 'synthetic'
      AND json_extract(m.data, '$.metadata.source') = 'subagent'
      AND json_extract(m.data, '$.metadata.childID') = ?
      AND json_type(m.data, '$.time.created') IN ('integer', 'real')
      AND json_extract(m.data, '$.time.created') >= ?
    ORDER BY m.seq DESC LIMIT 1`).get(childId, childId, startedAt) as { parentId: string; at: number } | undefined;
}
