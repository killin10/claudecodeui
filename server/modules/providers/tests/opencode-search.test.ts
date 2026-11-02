import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { searchConversations } from '@/modules/providers/services/session-conversations-search.service.js';

test('OpenCode content search uses app IDs, snippets and visible sessions without transcript files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-search-'));
  const previous = { DATABASE_PATH: process.env.DATABASE_PATH, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'cloudcli.db');
  process.env.XDG_DATA_HOME = root;
  await mkdir(path.join(root, 'opencode'));
  const native = new Database(path.join(root, 'opencode/opencode.db'));
  native.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
    CREATE INDEX session_message_session_seq ON session_message(session_id, seq);`);
  const insert = native.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
  const message = (id: string, sessionId: string, type: string, seq: number, data: object) => insert.run(id, sessionId, type, seq, JSON.stringify({ time: { created: 1700000000000 + seq }, ...data }));
  try {
    await initializeDatabase();
    for (const name of ['visible', 'archived', 'hidden-project']) {
      sessionsDb.createAppSession(`app-${name}`, 'opencode', path.join(root, name));
      sessionsDb.assignProviderSessionId(`app-${name}`, `ses_${name}`);
      message(`msg_${name}`, `ses_${name}`, 'user', 1, { text: 'Needle Alpha user prompt' });
    }
    sessionsDb.updateSessionIsArchived('app-archived', true);
    projectsDb.updateProjectIsArchived(path.join(root, 'hidden-project'), true);
    message('msg_unindexed', 'ses_unindexed', 'user', 1, { text: 'needle alpha outside app index' });
    message('msg_reply', 'ses_visible', 'assistant', 2, { content: [{ type: 'text', text: 'Answer with NEEDLE ALPHA.' }] });
    message('msg_tool', 'ses_visible', 'assistant', 3, { content: [{ type: 'tool', name: 'shell', state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'secretneedle' }] } }] });
    message('msg_internal', 'ses_visible', 'synthetic', 4, { text: 'secretneedle' });
    const progress: number[] = [];
    const result = await searchConversations('needle alpha', 50, (update) => progress.push(update.totalMatches));
    assert.equal(result.totalMatches, 2);
    assert.deepEqual(result.results.flatMap((project) => project.sessions.map((session) => session.sessionId)), ['app-visible']);
    const matches = result.results[0].sessions[0].matches;
    assert.deepEqual(matches.map((match) => match.messageUuid), ['msg_visible_0', 'msg_reply_text_0']);
    assert.equal(matches[0].timestamp, '2023-11-14T22:13:20.001Z');
    assert.ok(matches.every((match) => match.highlights.length === 1 && match.provider === 'opencode'));
    assert.deepEqual(progress, [2]);
    assert.equal((await searchConversations('secretneedle')).totalMatches, 0);
    assert.equal((await searchConversations('needle', 1)).totalMatches, 1);
    assert.equal((await searchConversations('needle', 50, null, AbortSignal.abort())).totalMatches, 0);
    const claudePath = path.join(root, 'claude.jsonl');
    await writeFile(claudePath, `${JSON.stringify({ sessionId: 'claude-native', uuid: 'claude-message', type: 'user', timestamp: '2023-11-14T22:13:20.000Z', message: { role: 'user', content: 'needle alpha from Claude' } })}\n`);
    sessionsDb.createSession('claude-native', 'claude', path.join(root, 'visible'), 'Claude title', undefined, undefined, claudePath);
    const mixed = await searchConversations('needle alpha');
    assert.deepEqual(new Set(mixed.results.flatMap((project) => project.sessions.map((session) => session.provider))), new Set(['claude', 'opencode']));

    // A large unmatched session yields between pages so an abandoned search stops promptly.
    for (let seq = 5; seq < 210; seq++) message(`msg_filler_${seq}`, 'ses_visible', 'user', seq, { text: seq === 209 ? 'lastneedle' : 'other text' });
    const abort = new AbortController();
    setImmediate(() => abort.abort());
    assert.equal((await searchConversations('lastneedle', 50, null, abort.signal)).totalMatches, 0);
    const plan = native.prepare("EXPLAIN QUERY PLAN SELECT id FROM session_message WHERE session_id = ? AND seq > ? AND type IN ('user', 'assistant') ORDER BY seq LIMIT 100").all('ses_visible', 0);
    assert.match(JSON.stringify(plan), /session_message_session_seq/);
  } finally {
    native.close();
    closeConnection();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
