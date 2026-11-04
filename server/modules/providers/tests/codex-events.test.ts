import assert from 'node:assert/strict';
import test from 'node:test';

import { unifiedDiffToTexts } from '@/shared/utils.js';
import { CodexRunEvents } from '@/modules/providers/list/codex/codex-events.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

function projection() {
  const messages: AnyRecord[] = [];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => 'root', resolveResumeModel: async () => 'fixture',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'fixture' }), isProviderInstalled: async () => true,
    normalizeMessage: (raw, id) => new CodexSessionsProvider().normalizeMessage(raw, id),
  };
  return { messages, events: new CodexRunEvents({ send: message => messages.push(message as AnyRecord) }, context, () => 'app', () => 'root') };
}

test('child output arriving before spawn completion stays inside its agent card', () => {
  const { messages, events } = projection();
  events.handle('item/completed', { threadId: 'child', item: { id: 'answer', type: 'agentMessage', text: 'Child answer' } });
  assert.equal(messages.length, 0);
  events.handle('item/completed', { threadId: 'root', item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'completed' } } } });
  const answer = messages.find(message => message.kind === 'text');
  assert.equal(answer?.parentToolUseId, 'spawn');
  assert.equal(answer?.content, 'Child answer');
  assert.equal(events.tasks.size, 0);
});

test('native file changes preserve a real diff and a denied result', () => {
  const { messages, events } = projection();
  events.handle('item/completed', { threadId: 'root', item: { id: 'patch', type: 'fileChange', status: 'declined', changes: [{ path: '/project/file', kind: { type: 'update' }, diff: '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n' }] } });
  assert.deepEqual(messages[0].toolInput, { file_path: '/project/file', old_string: 'old', new_string: 'new' });
  assert.equal(messages[1].isError, true);
});


test('a native idle notification does not overwrite interruption, but a new turn can run again', () => {
  const { events } = projection();
  events.handle('item/completed', { threadId: 'root', item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } } });
  events.handle('turn/completed', { threadId: 'child', turn: { id: 'first', status: 'interrupted' } });
  events.handle('thread/status/changed', { threadId: 'child', status: { type: 'idle' } });
  assert.equal(events.taskCards.get('child')?.subagent?.status, 'stopped');
  events.handle('turn/started', { threadId: 'child', turn: { id: 'second' } });
  assert.equal(events.tasks.has('child'), true);
  events.handle('turn/completed', { threadId: 'child', turn: { id: 'second', status: 'completed' } });
  assert.equal(events.taskCards.get('child')?.subagent?.status, 'completed');
});

test('diff metadata does not swallow header-like file content', () => {
  assert.deepEqual(unifiedDiffToTexts('--- a/file\n+++ b/file\n@@ -1 +1 @@\n--- old comment\n+++ new comment\n'), {
    oldText: '-- old comment', newText: '++ new comment',
  });
});

test('compaction updates one row with native duration and never invents context token counts', () => {
  const { events, messages } = projection();
  const item = { id: 'compact-1', type: 'contextCompaction', startedAtMs: 1000 };
  events.handle('item/started', { threadId: 'root', turnId: 'turn', item });
  assert.equal(messages[0].compact.phase, 'running');
  events.handle('item/completed', { threadId: 'root', turnId: 'turn', item: { ...item, completedAtMs: 3500 } });
  assert.equal(messages[1].id, messages[0].id);
  assert.equal(messages[1].compact.phase, 'done');
  assert.equal(messages[1].compact.durationMs, 2500);
  assert.equal(messages[1].compact.preTokens, undefined);
  assert.equal(messages[1].compact.postTokens, undefined);
  const history = new CodexSessionsProvider().normalizeMessage({ type: 'compaction', uuid: item.id,
    phase: 'done', startedAtMs: 1000, completedAtMs: 3500,
  }, 'app')[0];
  assert.equal(history.content, messages[1].content);
  assert.equal(history.id, messages[1].id);
  assert.equal(history.timestamp, messages[1].timestamp);
  events.stopAll();
  assert.equal(messages.length, 2);
});

test('unfinished compaction fails on interruption while child compaction stays out of the parent', () => {
  const { events, messages } = projection();
  const item = { id: 'compact', type: 'contextCompaction' };
  events.handle('item/started', { threadId: 'child', turnId: 'child-turn', item });
  assert.equal(messages.length, 0);
  events.handle('item/started', { threadId: 'root', turnId: 'turn', item });
  events.handle('turn/completed', { threadId: 'root', turn: { id: 'turn', status: 'interrupted' } });
  assert.equal(messages.at(-1)?.compact.phase, 'failed');
  assert.equal(messages.at(-1)?.compact.durationMs, undefined);
  events.stopAll();
  assert.equal(messages.length, 2);
});
