import { getConnection } from '@/modules/database/connection.js';
import type { SessionSubmission } from '@/shared/types.js';

import { sessionsDb } from './sessions.db.js';

/** Schema consumed by database initialization; receipts intentionally survive session deletion. */
export const SESSION_CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_control_receipts (
 user_id INTEGER NOT NULL, operation TEXT NOT NULL, token TEXT NOT NULL,
 fingerprint TEXT NOT NULL, response TEXT NOT NULL,
 PRIMARY KEY(user_id, operation, token)
);
CREATE TABLE IF NOT EXISTS session_runtime_settings (
 session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
 permission_mode TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_submissions (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL, content TEXT NOT NULL, options TEXT NOT NULL,
 state TEXT NOT NULL, result TEXT, error TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS session_control_delete_receipts AFTER DELETE ON sessions
BEGIN
 UPDATE session_control_receipts
 SET response=json_object('sessionId', OLD.session_id, 'deleted', json('true'))
 WHERE json_extract(response, '$.sessionId')=OLD.session_id;
END;
CREATE INDEX IF NOT EXISTS session_control_receipt_session ON session_control_receipts(json_extract(response, '$.sessionId'));
CREATE INDEX IF NOT EXISTS sessions_control_listing ON sessions(isArchived, updated_at DESC, session_id DESC);
CREATE INDEX IF NOT EXISTS session_submissions_queue ON session_submissions(state, created_at, id);
CREATE INDEX IF NOT EXISTS session_submissions_session ON session_submissions(session_id, state);
`;

type SubmissionRow = {
  id: string;
  session_id: string;
  user_id: number;
  content: string;
  options: string;
  state: SessionSubmission['state'];
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function decode(row: SubmissionRow): SessionSubmission {
  return {
    submissionId: row.id, sessionId: row.session_id, userId: row.user_id,
    content: row.content, options: JSON.parse(row.options), state: row.state,
    result: row.result ? JSON.parse(row.result) : [], error: row.error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Persistence used by session-control and the shared chat gateway. */
export const sessionControlDb = {
  listSessions(input: {
    provider?: string;
    projectPath?: string;
    search?: string;
    archiveState: string;
    runningIds?: string[];
    idleIds?: string[];
    cursor?: [
      string,
      string
    ];
    limit: number;
  }) {
    const predicates: string[] = [];
    const args: Array<string | number> = [];
    if (input.archiveState !== 'all') {
      predicates.push('isArchived=?');
      args.push(input.archiveState === 'archived' ? 1 : 0);
    }
    if (input.provider) {
      predicates.push('provider=?');
      args.push(input.provider);
    }
    if (input.projectPath) {
      predicates.push('project_path=?');
      args.push(input.projectPath);
    }
    if (input.search) {
      predicates.push("instr(lower(COALESCE(custom_name,'')),lower(?))>0");
      args.push(input.search);
    }
    if (input.runningIds) {
      predicates.push(`session_id IN (${input.runningIds.map(() => '?').join(',') || "NULL"})`);
      args.push(...input.runningIds);
    }
    if (input.idleIds?.length) {
      predicates.push(`session_id NOT IN (${input.idleIds.map(() => '?').join(',')})`);
      args.push(...input.idleIds);
    }
    if (input.cursor) {
      predicates.push('(updated_at,session_id)<(?,?)');
      args.push(...input.cursor);
    }
    return getConnection().prepare(`SELECT * FROM sessions ${predicates.length ? 'WHERE ' + predicates.join(' AND ') : ''} ORDER BY updated_at DESC, session_id DESC LIMIT ?`)
      .all(...args, input.limit) as NonNullable<ReturnType<typeof sessionsDb.getSessionById>>[];
  },
  hasOtherPending(sessionId: string): boolean {
    const db = getConnection();
    return Boolean(db.prepare("SELECT 1 FROM session_drafts WHERE draft_scope=? AND queued_message IS NOT NULL LIMIT 1").get(sessionId)
      || db.prepare("SELECT 1 FROM scheduled_messages WHERE session_id=? AND status='pending' LIMIT 1").get(sessionId));
  },
  receipt(userId: number, operation: string, token: string) {
    return getConnection().prepare('SELECT fingerprint, response FROM session_control_receipts WHERE user_id=? AND operation=? AND token=?')
      .get(userId, operation, token) as {
      fingerprint: string;
      response: string;
    } | undefined;
  },
  saveReceipt(userId: number, operation: string, token: string, fingerprint: string, response: unknown) {
    getConnection().prepare('INSERT INTO session_control_receipts VALUES (?, ?, ?, ?, ?)')
      .run(userId, operation, token, fingerprint, JSON.stringify(response));
  },
  permission(sessionId: string): string | null {
    const row = getConnection().prepare('SELECT permission_mode FROM session_runtime_settings WHERE session_id=?').get(sessionId) as {
      permission_mode: string;
    } | undefined;
    return row?.permission_mode ?? null;
  },
  setPermission(sessionId: string, mode: string) {
    getConnection().prepare('INSERT INTO session_runtime_settings VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET permission_mode=excluded.permission_mode').run(sessionId, mode);
  },
  insert(row: SessionSubmission) {
    getConnection().prepare('INSERT INTO session_submissions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.submissionId, row.sessionId, row.userId, row.content, JSON.stringify(row.options), row.state, null, null, row.createdAt, row.updatedAt);
  },
  get(id: string, userId: number): SessionSubmission | null {
    const row = getConnection().prepare('SELECT * FROM session_submissions WHERE id=? AND user_id=?').get(id, userId) as SubmissionRow | undefined;
    return row ? decode(row) : null;
  },
  hasQueued(): boolean {
    return Boolean(getConnection().prepare("SELECT 1 FROM session_submissions WHERE state='queued' LIMIT 1").get());
  },
  queued(excluded: string[] = []): SessionSubmission[] {
    return (getConnection().prepare(`SELECT * FROM session_submissions WHERE state='queued' ${excluded.length ? 'AND session_id NOT IN (' + excluded.map(() => '?').join(',') + ')' : ''} ORDER BY rowid LIMIT 100`).all(...excluded) as SubmissionRow[]).map(decode);
  },
  pending(sessionId: string): number {
    return (getConnection().prepare("SELECT count(*) AS n FROM session_submissions WHERE session_id=? AND state IN ('queued','running','waiting-for-input')").get(sessionId) as {
      n: number;
    }).n;
  },
  transition(id: string, from: SessionSubmission['state'][], state: SessionSubmission['state'], result: unknown = null, error: string | null = null): boolean {
    return getConnection().prepare(`UPDATE session_submissions SET state=?, result=COALESCE(?,result), error=?, updated_at=? WHERE id=? AND state IN (${from.map(() => '?').join(',')})`)
      .run(state, result === null ? null : JSON.stringify(result), error, new Date().toISOString(), id, ...from).changes > 0;
  },
  recover() {
    getConnection().prepare("UPDATE session_submissions SET state='interrupted', error='Server restarted during execution; inspect history before resubmitting.', updated_at=? WHERE state IN ('running','waiting-for-input')")
      .run(new Date().toISOString());
  },
};
