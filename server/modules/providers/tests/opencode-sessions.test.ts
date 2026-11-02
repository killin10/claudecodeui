import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { appendImagesInputTag } from '@/shared/image-attachments.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const createOpenCodeDatabase = async (homeDir: string, workspacePath: string): Promise<void> => {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, metadata TEXT,
        time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
        tokens_input INTEGER DEFAULT 10, tokens_output INTEGER DEFAULT 20,
        tokens_reasoning INTEGER DEFAULT 7, tokens_cache_read INTEGER DEFAULT 3, tokens_cache_write INTEGER DEFAULT 2
      );
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
    `);
    db.prepare('INSERT INTO project VALUES (?, ?)').run('project-1', workspacePath);
    const session = db.prepare('INSERT INTO session_v2 (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)');
    session.run('open-session-1', 'project-1', null, workspacePath, 'OpenCode indexed title', 1700000000000, 1700000004000);
    session.run('open-child-session-1', 'project-1', 'open-session-1', workspacePath, 'Child', 1700000002000, 1700000005000);
    const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
    insert.run('message-user', 'open-session-1', 'user', 1, JSON.stringify({
      time: { created: 1700000001000 }, text: 'Build the OpenCode integration.',
    }));
    insert.run('message-assistant', 'open-session-1', 'assistant', 2, JSON.stringify({
      time: { created: 1700000002000, completed: 1700000003000 },
      content: [
        { type: 'reasoning', text: 'I will inspect the provider shape first.' },
        { type: 'text', text: 'The provider is wired.' },
        { type: 'tool', name: 'shell', id: 'tool-call-1',
          state: { status: 'completed', input: { command: 'npm test' }, content: [{ type: 'text', text: 'ok' }] } },
      ],
    }));
  } finally {
    db.close();
  }
};

test('OpenCode session synchronizer indexes sqlite sessions without deletable transcript paths', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-child-session-1', 'opencode', workspacePath);
      sessionsDb.assignProviderSessionId('app-child-session-1', 'open-child-session-1');

      const synchronizer = new OpenCodeSessionSynchronizer();
      const processed = synchronizer.synchronize();

      return Promise.resolve(processed).then(async (count) => {
        assert.equal(count, 1);
        const indexed = sessionsDb.getSessionById('open-session-1');
        assert.equal(indexed?.provider, 'opencode');
        assert.equal(indexed?.project_path, workspacePath);
        assert.equal(indexed?.custom_name, 'OpenCode indexed title');
        assert.equal(indexed?.jsonl_path, null);
        assert.equal(sessionsDb.getSessionById('app-child-session-1'), null);
        assert.equal(sessionsDb.getSessionByProviderSessionId('open-child-session-1'), null);

        sessionsDb.createAppSession('app-child-session-2', 'opencode', workspacePath);
        sessionsDb.assignProviderSessionId('app-child-session-2', 'open-child-session-1');
        await synchronizer.synchronize(new Date(1_700_000_004_500));
        assert.equal(
          sessionsDb.getSessionById('app-child-session-2')?.provider_session_id,
          'open-child-session-1',
        );
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer returns the app session id once provider mapping exists', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-mapped-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-session-1', 'opencode', workspacePath);
      sessionsDb.assignProviderSessionId('app-session-1', 'open-session-1');

      const synchronizer = new OpenCodeSessionSynchronizer();
      return synchronizer.synchronizeFile(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db')).then((sessionId) => {
        assert.equal(sessionId, 'app-session-1');
        assert.equal(sessionsDb.getAllSessions().length, 1);
        assert.equal(sessionsDb.getSessionById('app-session-1')?.provider_session_id, 'open-session-1');
        assert.equal(sessionsDb.getSessionById('open-child-session-1'), null);
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer adopts the pending app session before watcher sync creates a duplicate', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-race-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    const db = new Database(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'));
    db.prepare('UPDATE session_v2 SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ cloudcliSessionId: 'app-session-race' }), 'open-session-1');
    db.close();
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-session-race', 'opencode', workspacePath);

      const synchronizer = new OpenCodeSessionSynchronizer();
      return synchronizer.synchronizeFile(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db-wal')).then((sessionId) => {
        assert.equal(sessionId, 'app-session-race');
        assert.equal(sessionsDb.getAllSessions().length, 1);
        assert.equal(sessionsDb.getSessionById('app-session-race')?.provider_session_id, 'open-session-1');
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('V2 history discovery does not adopt an unrelated pending app session in the same directory', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-unrelated-session-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('pending-app', 'opencode', workspacePath);
      await new OpenCodeSessionSynchronizer().synchronize();
      assert.equal(sessionsDb.getSessionById('pending-app')?.provider_session_id, null);
      assert.ok(sessionsDb.getSessionByProviderSessionId('open-session-1'));
      assert.equal(sessionsDb.getAllSessions().length, 2);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode sessions provider strips <images_input> from user turns and exposes attachments', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-images-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);

    // Rewrite the user text part with the tagged prompt the runtime sends.
    const taggedPrompt = appendImagesInputTag('Look at this screenshot.', [
      { path: 'C:/Users/x/.cloudcli/assets/shot.png' },
    ]);
    const db = new Database(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'));
    try {
      db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(
        JSON.stringify({ type: 'text', text: taggedPrompt }),
        'message-user',
      );
    } finally {
      db.close();
    }

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-session-1');
    const userMessage = history.messages.find((message) => message.kind === 'text' && message.role === 'user');

    assert.equal(userMessage?.content, 'Look at this screenshot.');
    assert.deepEqual(userMessage?.images, [{ path: 'C:/Users/x/.cloudcli/assets/shot.png' }]);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

const normalizeLiveMessage = (message: Record<string, unknown>) =>
  new OpenCodeSessionsProvider().normalizeMessage({ type: 'session.message', message }, 'app-session');

test('V2 content keeps separate stable ids for text, reasoning and tool results', () => {
  const messages = normalizeLiveMessage({ id: 'msg_1', type: 'assistant', time: { created: 1700000000000 },
    content: [
      { type: 'text', text: 'Checking.' },
      { type: 'reasoning', text: 'Thinking.' },
      { type: 'text', text: 'Done.' },
      { type: 'tool', id: 'call_1', name: 'shell', state: { status: 'completed',
        input: { command: 'echo hi' }, content: [{ type: 'text', text: 'hi' }] } },
    ],
  });
  assert.deepEqual(messages.map((m) => [m.id, m.kind]),
    [['msg_1_0', 'text'], ['msg_1_1', 'thinking'], ['msg_1_2', 'text'], ['msg_1_3', 'tool_use']]);
  assert.deepEqual(messages[3].toolResult, { content: 'hi', isError: false });
  assert.deepEqual(messages[3].toolInput, { command: 'echo hi' });
  assert.equal(messages[3].toolId, 'call_1');
});

test('V2 errors and failed tool calls retain their readable messages', () => {
  const messages = normalizeLiveMessage({ id: 'msg_error', type: 'assistant',
    error: { type: 'APIError', message: 'Rate limit exceeded' },
    content: [{ type: 'tool', name: 'read', id: 'call_read',
      state: { status: 'error', input: {}, error: { type: 'ToolError', message: 'File missing' } } }],
  });
  assert.equal(messages[0].content, 'Rate limit exceeded');
  assert.deepEqual(messages[1].toolResult, { content: 'File missing', isError: true });
});

test('V1 wire events are no longer accepted', () => {
  assert.deepEqual(new OpenCodeSessionsProvider().normalizeMessage({ type: 'text', text: 'v1' }, 'app'), []);
});

test('OpenCode sessions provider reads sqlite history and token usage', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-session-1');

    assert.equal(history.total, 5);
    assert.equal(history.messages[0]?.kind, 'text');
    assert.equal(history.messages[0]?.role, 'user');
    assert.equal(history.messages[0]?.content, 'Build the OpenCode integration.');
    assert.equal(history.messages[1]?.kind, 'thinking');
    assert.equal(history.messages[2]?.content, 'The provider is wired.');
    assert.equal(history.messages[3]?.kind, 'tool_use');
    assert.deepEqual(history.messages[3]?.toolResult, { content: 'ok', isError: false });
    assert.deepEqual(history.tokenUsage, {
      used: 42,
      inputTokens: 13,
      outputTokens: 20,
      breakdown: {
        input: 13,
        output: 20,
      },
    });

    const paged = await provider.fetchHistory('open-session-1', { limit: 2, offset: 0 });
    assert.equal(paged.messages.length, 2);
    assert.equal(paged.hasMore, true);
    assert.equal(paged.messages[0]?.kind, 'tool_use');
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

const QUESTION_TOOL_STATE = {
  status: 'completed',
  input: {
    questions: [
      { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] },
      {
        question: 'Which sizes?',
        header: 'Sizes',
        multiple: true,
        options: [{ label: 'Small', description: '' }, { label: 'Large, wide', description: '' }],
      },
    ],
  },
  output: 'User has answered your questions: "Which color?"="Red", "Which sizes?"="Small, Large, wide".',
  title: 'Asked 2 questions',
  // OpenCode keeps the picked labels as one list per question.
  metadata: { answers: [['Red'], ['Small', 'Large, wide']] },
  time: { start: 0, end: 1 },
};

test('OpenCode sessions provider shows a live question call as the question card with its answers', () => {
  const [message] = normalizeLiveMessage({
    id: 'msg_question', type: 'assistant', content: [
      { type: 'tool', name: 'question', id: 'call_q', state: { ...QUESTION_TOOL_STATE,
        content: [{ type: 'text', text: 'Answered' }] } },
    ],
  });

  assert.equal(message?.toolName, 'AskUserQuestion');
  const input = message?.toolInput as { questions: Array<{ multiSelect?: boolean }>; answers?: unknown } | undefined;
  assert.equal(input?.questions[1]?.multiSelect, true);
  assert.deepEqual(input?.answers, { 'Which color?': 'Red', 'Which sizes?': 'Small, Large, wide' });
  assert.equal(message?.toolResult?.isError, false);
});

test('OpenCode history hides the error of a stopped turn and shows question calls as question cards', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-stopped-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    const db = new Database(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'));
    try {
      const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
      insert.run('message-stopped', 'open-session-1', 'idle', 3, JSON.stringify({
        outcome: 'interrupted', time: { created: 1700000005000 },
      }));
      insert.run('message-failed', 'open-session-1', 'assistant', 4, JSON.stringify({
        error: { type: 'APIError', message: 'Rate limit exceeded' },
        content: [{ type: 'tool', name: 'question', id: 'call_q', state: { ...QUESTION_TOOL_STATE,
          content: [{ type: 'text', text: 'Answered' }] } }],
      }));
    } finally {
      db.close();
    }

    const history = await new OpenCodeSessionsProvider().fetchHistory('open-session-1');
    const errors = history.messages.filter((message) => message.kind === 'error');
    assert.equal(errors.length, 1, 'only the real failure shows as an error');
    assert.match(String(errors[0]?.content), /Rate limit exceeded/);

    const card = history.messages.find((message) => message.toolId === 'call_q');
    assert.equal(card?.toolName, 'AskUserQuestion');
    const cardInput = card?.toolInput as { answers?: unknown } | undefined;
    assert.deepEqual(cardInput?.answers, { 'Which color?': 'Red', 'Which sizes?': 'Small, Large, wide' });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Seeds a single OpenCode session with a controllable stored title and first
 * user message. Uses a minimal schema (only the columns the synchronizer reads)
 * with a plain-text user part so the derived name is unambiguous.
 */
const seedOpenCodeSession = async (
  homeDir: string,
  workspacePath: string,
  options: { sessionId: string; title: string | null; firstUserText: string },
): Promise<void> => {
  await createOpenCodeDatabase(homeDir, workspacePath);
  const db = new Database(path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db'));
  try {
    db.prepare('DELETE FROM session_v2').run();
    db.prepare('DELETE FROM session_message').run();
    db.prepare('INSERT INTO session_v2 (id, project_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
      .run(options.sessionId, 'project-1', workspacePath, options.title, 1700000000000, 1700000001000);
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)')
      .run('user-1', options.sessionId, 'user', 1, JSON.stringify({ text: options.firstUserText }));
  } finally {
    db.close();
  }
};

test('OpenCode synchronizer preserves the title assigned when CloudCLI creates a session', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-app-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // Both provider-owned values differ from the CloudCLI title so either one
    // leaking through would change the assertion below.
    await seedOpenCodeSession(tempRoot, workspacePath, {
      sessionId: 'oc-app-1',
      title: 'OpenCode generated title',
      firstUserText: 'OpenCode first user prompt',
    });
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'opencode', workspacePath, 'Fix the checkout crash');
      sessionsDb.assignProviderSessionId('app-1', 'oc-app-1');

      await new OpenCodeSessionSynchronizer().synchronize();

      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Fix the checkout crash');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode synchronizer keeps the stored title for indexed sessions', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-indexed-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await seedOpenCodeSession(tempRoot, workspacePath, {
      sessionId: 'oc-indexed-1',
      title: 'OpenCode generated title',
      firstUserText: 'This prompt should be ignored',
    });
    await withIsolatedDatabase(async () => {
      await new OpenCodeSessionSynchronizer().synchronize();

      assert.equal(sessionsDb.getSessionById('oc-indexed-1')?.custom_name, 'OpenCode generated title');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
