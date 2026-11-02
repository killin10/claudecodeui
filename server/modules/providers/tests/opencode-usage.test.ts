import assert from 'node:assert/strict';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { readOpenCodeUsage } from '@/modules/providers/list/opencode/opencode-usage.provider.js';

test('OpenCode current context is the last request, with compaction invalidation and independent cumulative usage', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE session_v2 (id TEXT, model TEXT, metadata TEXT, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL);
      CREATE TABLE session_message (session_id TEXT, type TEXT, seq INTEGER, data TEXT);`);
    db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, 1000, 200, 30, 400, 50, 0.25)').run('ses_test',
      JSON.stringify({ providerID: 'test', id: 'large' }),
      JSON.stringify({ cloudcliModelContextWindows: { 'test/large': 256000, 'test/small': 32000 } }));
    assert.equal(readOpenCodeUsage(db, 'ses_missing'), undefined);
    const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)');
    insert.run('ses_test', 'assistant', 1, JSON.stringify({ tokens: { input: 500, output: 50 } }));
    insert.run('ses_test', 'assistant', 2, JSON.stringify({ model: { providerID: 'test', id: 'small' },
      tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 20, write: 2 } } }));
    insert.run('ses_foreign', 'assistant', 100, JSON.stringify({ tokens: { input: 99999 } }));
    const usage = readOpenCodeUsage(db, 'ses_test')!;
    assert.equal(usage.used, 40);
    assert.equal(usage.inputTokens, 32);
    assert.equal(usage.outputTokens, 8);
    assert.equal(usage.total, 32000);
    assert.equal(usage.cumulative.used, 1680);
    assert.equal(usage.cumulative.cost, 0.25);
    insert.run('ses_test', 'compaction', 3, JSON.stringify({ status: 'failed' }));
    assert.equal(readOpenCodeUsage(db, 'ses_test')!.used, 40);
    insert.run('ses_test', 'compaction', 4, JSON.stringify({ status: 'completed', tokens: { input: 5000 } }));
    const compacted = readOpenCodeUsage(db, 'ses_test')!;
    assert.equal(compacted.contextUnavailable, true);
    assert.equal(compacted.used, 0);
    assert.equal(compacted.cumulative.used, 1680);
    insert.run('ses_test', 'assistant', 5, JSON.stringify({ tokens: { input: 7, output: 1 } }));
    assert.equal(readOpenCodeUsage(db, 'ses_test')!.used, 8);
    assert.equal(readOpenCodeUsage(db, 'ses_test')!.contextUnavailable, false);
  } finally {
    db.close();
  }
});
