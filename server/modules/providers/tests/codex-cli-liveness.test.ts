import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexCliLivenessReader } from '@/modules/providers/services/codex-cli-liveness.service.js';
import { readCodexContextUsage } from '@/shared/utils.js';

test('Codex external status requires both an open native file and an unfinished turn', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-live-'));
  const id = '01a1215d-5dfb-7c12-a505-87d34de2953b';
  const file = path.join(directory, `rollout-${id}.jsonl`);
  const start = { type: 'event_msg', timestamp: '2026-11-03T00:00:00Z', payload: { type: 'task_started' } };
  let openFiles = [file];
  const read = createCodexCliLivenessReader(async () => openFiles);
  try {
    await writeFile(file, JSON.stringify(start) + '\n');
    assert.deepEqual(await read(), [{ providerSessionId: id, startedAt: Date.parse(start.timestamp) }]);
    await appendFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
    assert.deepEqual(await read(), []);
    await appendFile(file, JSON.stringify(start) + '\n');
    assert.equal((await read()).length, 1);
    openFiles = [];
    assert.deepEqual(await read(), [], 'a crashed writer cannot remain busy merely because its rollout lacks a terminal event');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Codex context snapshot never uses cumulative billing as occupancy or invents a window', () => {
  assert.deepEqual(readCodexContextUsage({ total_token_usage: { total_tokens: 900000 } }), {
    used: 0, inputTokens: 0, outputTokens: 0, breakdown: { input: 0, output: 0 }, contextUnavailable: true,
  });
  const snapshot = readCodexContextUsage({ model_context_window: 1000000, total_token_usage: { total_tokens: 900000 }, last_token_usage: { input_tokens: 30000, output_tokens: 1000, total_tokens: 31000 } });
  assert.equal(snapshot?.used, 31000);
  assert.equal(snapshot?.total, 1000000);
});
