import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SessionMessageInfo } from '@opencode/client';

import { OpenCodeBackgroundWork } from '@/modules/providers/list/opencode/opencode-background.provider.js';

const message = (callID: string): SessionMessageInfo => ({
  id: 'msg_background', type: 'assistant', time: { created: 1 },
  agent: 'build', model: { providerID: 'test', id: 'model' },
  content: [{ type: 'tool', name: 'subagent', id: callID, time: { created: 1, completed: 2 }, state: {
    status: 'completed', input: { background: true }, metadata: { sessionID: 'ses_child', status: 'running' }, content: [{ type: 'text', text: 'Running in background' }],
  } }],
});

test('detached child waits for delivery and followup, and a new call can resume the same child', () => {
  const work = new OpenCodeBackgroundWork();
  work.track(message('call_one'), false);
  work.executionEnded('ses_child');
  assert.equal(work.pending, true);
  work.notificationDelivered('ses_root', { source: 'subagent', childID: 'ses_child' });
  assert.equal(work.pending, true);
  work.track(message('call_one'), false);
  assert.equal(work.tasks.size, 0);
  work.executionEnded('ses_root');
  assert.equal(work.pending, false);
  work.track(message('call_two'), false);
  assert.equal(work.tasks.get('ses_child')?.toolUseId, 'call_two');
  work.track(message('call_one'), false);
  assert.equal(work.tasks.get('ses_child')?.toolUseId, 'call_two');
  work.executionEnded('ses_child');
  assert.equal(work.pending, true);
});

test('a delayed snapshot does not resurrect work whose notification was already delivered', () => {
  const work = new OpenCodeBackgroundWork();
  work.notificationDelivered('ses_root', { source: 'subagent', childID: 'ses_child' });
  work.track(message('call_one'), false);
  assert.equal(work.tasks.size, 0);
  work.executionEnded('ses_root');
  assert.equal(work.pending, false);
});

test('a native detached shell retains the host and settles without hiding model tool tasks', () => {
  const work = new OpenCodeBackgroundWork();
  const shell = { id: 'shl_direct', command: 'sleep 10', metadata: { background: true }, status: 'running' };
  work.trackNativeShell({ type: 'session.shell.started', created: 1, data: { shell } } as never, false);
  work.executionEnded('ses_parent');
  assert.equal(work.pending, true);
  assert.equal(work.tasks.get(shell.id)?.toolUseId, shell.id);
  work.trackNativeShell({ type: 'session.shell.ended', data: { shell } } as never, false);
  assert.equal(work.pending, false);
  work.track(message('model_call'), false);
  work.trackNativeShell({ type: 'session.shell.ended', data: { shell } } as never, false);
  assert.equal(work.pending, true);
});
