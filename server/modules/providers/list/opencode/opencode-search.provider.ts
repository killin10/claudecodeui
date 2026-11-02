import { existsSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';

import Database from 'better-sqlite3';

import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { getOpenCodeDatabasePath, readJsonRecord } from '@/shared/utils.js';

type SearchRow = { id: string; type: string; seq: number; data: string };

function* searchableMessages(row: SearchRow, sessionId: string, normalizer: OpenCodeSessionsProvider) {
  const data = readJsonRecord(row.data);
  if (!data) return;
  // Exclude tool output, credentials in arguments, and recursive subagent history.
  const content = Array.isArray(data.content)
    ? data.content.filter((part) => part?.type === 'text' || part?.type === 'reasoning') : [];
  const messages = normalizer.normalizeMessage({ type: 'session.message', message: {
    ...data, id: row.id, type: row.type, content,
  } }, sessionId, { hydrateSubagents: false });
  for (const message of messages) {
    if ((message.kind === 'text' || message.kind === 'thinking') && message.content?.trim()) {
      yield { id: message.id, role: row.type, text: message.content, timestamp: message.timestamp ?? null };
    }
  }
}

/** Used by conversation search to scan visible V2 session text without indexing tools or unrelated sessions. */
export async function* readOpenCodeSearchMessages(sessionId: string, isAborted: () => boolean) {
  const databasePath = getOpenCodeDatabasePath();
  if (!existsSync(databasePath) || isAborted()) return;
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  const normalizer = new OpenCodeSessionsProvider();
  try {
    const page = db.prepare(`SELECT id, type, seq, data FROM session_message
      WHERE session_id = ? AND seq > ? AND type IN ('user', 'assistant') ORDER BY seq LIMIT 100`);
    let after = -1;
    while (!isAborted()) {
      const rows = page.all(sessionId, after) as SearchRow[];
      if (rows.length === 0) return;
      for (const row of rows) {
        if (isAborted()) return;
        after = row.seq;
        yield* searchableMessages(row, sessionId, normalizer);
      }
      // Let cancelled HTTP searches release the reader before scanning another page.
      await setImmediate();
    }
  } finally {
    db.close();
  }
}
