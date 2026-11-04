import { getConnection } from '@/modules/database/connection.js';
import type { Schedule, ScheduleRun } from '@/shared/types.js';

/** Database initialization installs task/run storage and lifecycle guards for every session deletion path. */
export const SCHEDULES_SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
 session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
 definition TEXT NOT NULL, enabled INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL, next_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, deleted, next_run_at);
CREATE INDEX IF NOT EXISTS schedules_owner ON schedules(user_id, deleted, id);
CREATE INDEX IF NOT EXISTS schedules_session ON schedules(session_id);
CREATE TABLE IF NOT EXISTS schedule_runs (
 id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
 occurrence_key TEXT NOT NULL, scheduled_for TEXT NOT NULL, source TEXT NOT NULL,
 state TEXT NOT NULL, reason TEXT, submission_id TEXT REFERENCES session_submissions(id) ON DELETE SET NULL,
 snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(schedule_id, occurrence_key)
);
CREATE INDEX IF NOT EXISTS schedule_runs_history ON schedule_runs(schedule_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS schedule_runs_submission ON schedule_runs(submission_id);
CREATE TRIGGER IF NOT EXISTS schedules_archive AFTER UPDATE OF isArchived ON sessions
WHEN NEW.isArchived=1 AND OLD.isArchived=0
BEGIN
 UPDATE schedules SET enabled=0, next_run_at=NULL, revision=revision+1,
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE session_id=NEW.session_id;
END;
`;

type TaskRow = {
  id: string;
  user_id: number;
  session_id: string;
  definition: string;
  enabled: number;
  deleted: number;
  revision: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  session_title?: string | null;
  project_path?: string | null;
  provider?: string;
  last_state?: string | null;
};
type RunRow = {
  id: string;
  schedule_id: string;
  session_id: string;
  scheduled_for: string;
  source: ScheduleRun['source'];
  state: string;
  reason: string | null;
  submission_id: string | null;
  snapshot: string;
  created_at: string;
};
function task(row: TaskRow): Schedule {
  return {
    ...JSON.parse(row.definition),
    scheduleId: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    enabled: Boolean(row.enabled),
    deleted: Boolean(row.deleted),
    revision: row.revision,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionTitle: row.session_title,
    projectPath: row.project_path,
    provider: row.provider,
    lastState: row.last_state,
  };
}
function run(row: RunRow): ScheduleRun {
  return {
    runId: row.id,
    scheduleId: row.schedule_id,
    sessionId: row.session_id,
    scheduledFor: row.scheduled_for,
    source: row.source,
    state: row.state,
    reason: row.reason,
    submissionId: row.submission_id,
    snapshot: JSON.parse(row.snapshot),
    createdAt: row.created_at,
  };
}
const TASK_SELECT = `SELECT s.*, p.custom_name AS session_title, p.project_path, p.provider,
 (SELECT COALESCE(q.state,r.state) FROM schedule_runs r LEFT JOIN session_submissions q ON q.id=r.submission_id
 WHERE r.schedule_id=s.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS last_state
 FROM schedules s JOIN sessions p ON p.session_id=s.session_id`;
const RUN_SELECT = `SELECT r.*, COALESCE(s.state,r.state) AS state, COALESCE(s.error,r.reason) AS reason
 FROM schedule_runs r LEFT JOIN session_submissions s ON s.id=r.submission_id`;

/** Schedules service owns transactions; repository reads are bounded and owner-scoped at the service boundary. */
export const schedulesDb = {
  get(id: string): Schedule | null {
    const row = getConnection()
      .prepare(TASK_SELECT + ' WHERE s.id=?')
      .get(id) as TaskRow | undefined;
    return row ? task(row) : null;
  },
  list(userId: number, after: string, limit: number) {
    return (
      getConnection()
        .prepare(
          TASK_SELECT + ' WHERE s.user_id=? AND s.deleted=0 AND s.id>? ORDER BY s.id LIMIT ?',
        )
        .all(userId, after, limit) as TaskRow[]
    ).map(task);
  },
  save(value: Schedule) {
    const {
      scheduleId,
      userId,
      enabled,
      deleted,
      revision,
      nextRunAt,
      createdAt,
      updatedAt,
      sessionTitle: _title,
      projectPath: _path,
      provider: _provider,
      lastState: _state,
      ...definition
    } = value;
    getConnection()
      .prepare(
        `INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      definition=excluded.definition, enabled=excluded.enabled, deleted=excluded.deleted, revision=excluded.revision,
      next_run_at=excluded.next_run_at, updated_at=excluded.updated_at`,
      )
      .run(
        scheduleId,
        userId,
        value.sessionId,
        JSON.stringify(definition),
        Number(enabled),
        Number(deleted),
        revision,
        nextRunAt,
        createdAt,
        updatedAt,
      );
  },
  due(now: string) {
    return (
      getConnection()
        .prepare(
          'SELECT * FROM schedules WHERE enabled=1 AND deleted=0 AND next_run_at<=? ORDER BY next_run_at LIMIT 100',
        )
        .all(now) as TaskRow[]
    ).map(task);
  },
  pending(id: string): boolean {
    return Boolean(
      getConnection()
        .prepare(
          `SELECT 1 FROM schedule_runs r JOIN session_submissions s ON s.id=r.submission_id
      WHERE r.schedule_id=? AND s.state IN ('queued','running','waiting-for-input') LIMIT 1`,
        )
        .get(id),
    );
  },
  addRun(value: ScheduleRun, key: string) {
    getConnection()
      .prepare('INSERT INTO schedule_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        value.runId,
        value.scheduleId,
        value.sessionId,
        key,
        value.scheduledFor,
        value.source,
        value.state,
        value.reason,
        value.submissionId,
        JSON.stringify(value.snapshot),
        value.createdAt,
      );
    schedulesDb.pruneRuns(value.scheduleId);
  },
  /** Scheduler and run insertion retain the latest ten records per task plus unfinished work.
   * Submission content and idempotency receipts are independent and must not be deleted here.
   */
  pruneRuns(scheduleId?: string) {
    return getConnection().prepare(`
      WITH ranked AS (
        SELECT r.id, COALESCE(s.state, r.state) AS state,
          ROW_NUMBER() OVER (PARTITION BY r.schedule_id ORDER BY r.created_at DESC, r.id DESC) AS position
        FROM schedule_runs r LEFT JOIN session_submissions s ON s.id = r.submission_id
        ${scheduleId ? 'WHERE r.schedule_id = ?' : ''}
      )
      DELETE FROM schedule_runs WHERE id IN (
        SELECT id FROM ranked WHERE position > 10
          AND state IN ('succeeded', 'failed', 'cancelled', 'interrupted', 'skipped')
      )
    `).run(...(scheduleId ? [scheduleId] : [])).changes;
  },
  run(id: string): ScheduleRun | null {
    const row = getConnection()
      .prepare(RUN_SELECT + ' WHERE r.id=?')
      .get(id) as RunRow | undefined;
    return row ? run(row) : null;
  },
  runs(id: string, before: [string, string] | null, limit: number) {
    const condition = before ? ' AND (r.created_at,r.id)<(?,?)' : '';
    return (
      getConnection()
        .prepare(
          RUN_SELECT +
            ` WHERE r.schedule_id=?${condition} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
        )
        .all(id, ...(before ?? []), limit) as RunRow[]
    ).map(run);
  },
};
