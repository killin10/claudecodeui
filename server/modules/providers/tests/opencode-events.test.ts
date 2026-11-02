import assert from 'node:assert/strict';
import test from 'node:test';

import type { OpenCodeEvent } from '@opencode/client';

import { OpenCodeEventProjector } from '@/modules/providers/list/opencode/opencode-events.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

test('text and reasoning have independent ordinals and reconcile with persisted rows', () => {
  const frames: NormalizedMessage[] = [];
  const projector = new OpenCodeEventProjector(() => 'app', (frame) => frames.push(frame));
  const event = (type: string, value: string) => ({
    type, id: 'evt_1', created: 1,
    data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 0, delta: value, text: value },
  } as OpenCodeEvent);
  projector.handle(event('session.reasoning.delta', 'Think'));
  projector.handle(event('session.text.delta', 'Answer'));
  projector.handle(event('session.text.ended', 'Answer'));
  projector.handle(event('session.text.delta', 'stale'));
  assert.deepEqual(frames.map((frame) => frame.id), ['msg_1_reasoning_0', 'msg_1_text_0']);
  const history = new OpenCodeSessionsProvider().normalizeMessage({ type: 'session.message', message: {
    id: 'msg_1', type: 'assistant', time: { created: 1 }, content: [
      { type: 'reasoning', text: 'Think' }, { type: 'text', text: 'Answer' },
    ],
  } }, 'app');
  assert.deepEqual(history.map((frame) => frame.id), frames.map((frame) => frame.id));
});

test('compaction updates the same native history row from running to done', () => {
  const frames: NormalizedMessage[] = [];
  const projector = new OpenCodeEventProjector(() => 'app', (frame) => frames.push(frame));
  projector.handle({ type: 'session.compaction.started', id: 'evt_start', created: 1,
    data: { sessionID: 'ses_1', inputID: 'msg_compact', reason: 'auto' } } as OpenCodeEvent);
  projector.handle({ type: 'session.compaction.ended', id: 'evt_end', created: 2,
    data: { sessionID: 'ses_1', reason: 'auto', text: 'Summary' } } as OpenCodeEvent);
  assert.deepEqual(frames.map((frame) => frame.id), ['msg_compact_0', 'msg_compact_0']);
  assert.deepEqual(frames.map((frame) => frame.compact?.phase), ['running', 'done']);
  assert.equal(frames[1].content, 'Summary');
});
