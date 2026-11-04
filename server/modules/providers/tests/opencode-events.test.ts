import assert from 'node:assert/strict';
import test from 'node:test';

import type { OpenCodeEvent } from '@opencode/client';

import { OpenCodeEventProjector } from '@/modules/providers/list/opencode/opencode-events.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

const sessions = new OpenCodeSessionsProvider();
const normalize = (raw: unknown, sessionId: string | null) => sessions.normalizeMessage(raw, sessionId);

test('text and reasoning have independent ordinals and reconcile with persisted rows', () => {
  const frames: NormalizedMessage[] = [];
  const projector = new OpenCodeEventProjector(() => 'app', (frame) => frames.push(frame), normalize);
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
  const projector = new OpenCodeEventProjector(() => 'app', (frame) => frames.push(frame), normalize);
  projector.handle({ type: 'session.compaction.started', id: 'evt_start', created: 1,
    data: { sessionID: 'ses_1', inputID: 'msg_compact', reason: 'auto' } } as OpenCodeEvent);
  projector.handle({ type: 'session.compaction.ended', id: 'evt_end', created: 2,
    data: { sessionID: 'ses_1', reason: 'auto', text: 'Summary' } } as OpenCodeEvent);
  assert.deepEqual(frames.map((frame) => frame.id), ['msg_compact_0', 'msg_compact_0']);
  assert.deepEqual(frames.map((frame) => frame.compact?.phase), ['running', 'done']);
  assert.equal(frames[1].content, 'Context compacted · 0.0s\nSummary');
  assert.equal(frames[1].compact?.durationMs, 1);
});

test('durable notices share their history identity and replay does not duplicate them', () => {
  const frames: NormalizedMessage[] = [];
  const projector = new OpenCodeEventProjector(() => 'app', (frame) => frames.push(frame), normalize);
  const cases = [
    ['session.skill.activated', { id: 'review', name: 'Review', text: 'Review instructions' }, { type: 'skill', name: 'Review', text: 'Review instructions' }],
    ['session.agent.selected', { agent: 'plan' }, { type: 'agent-switched', agent: 'plan' }],
    ['session.model.selected', { model: { providerID: 'test', id: 'model' } }, { type: 'model-switched', model: { providerID: 'test', id: 'model' } }],
    ['session.moved', { location: { directory: '/repo' } }, { type: 'location-switched', location: { directory: '/repo' } }],
    ['session.synthetic', { text: 'Background done' }, { type: 'synthetic', text: 'Background done' }],
    ['session.instructions.updated', { text: 'New instructions' }, { type: 'system', text: 'New instructions' }],
  ] as const;
  for (const [index, [type, data, message]] of cases.entries()) {
    const event = { id: `evt_${index}`, created: 1700000000000, type, data: { sessionID: 'ses_native', ...data } } as OpenCodeEvent;
    assert.equal(projector.handle(event), true);
    projector.handle(event);
    const history = normalize({ type: 'session.message', message: {
      ...message, id: `msg_${index}`, time: { created: 1700000000000 },
    } }, 'app')[0];
    assert.deepEqual(frames[index], history);
    projector.publish(history);
    assert.equal(frames.length, index + 1);
  }
});

test('Code Mode catalog updates stay internal in both live events and persisted history', () => {
  const frames: NormalizedMessage[] = [];
  const projector = new OpenCodeEventProjector(() => 'app', (frame) => frames.push(frame), normalize);
  const text = 'The Code Mode tool catalog has changed.';
  const event = { type: 'session.instructions.updated', id: 'evt_catalog', created: 1,
    durable: { aggregateID: 'ses_native', seq: 1, version: 2 },
    data: { sessionID: 'ses_native', delta: { 'core/codemode': 'hash' }, text } } as OpenCodeEvent;
  assert.equal(projector.handle(event), true);
  assert.deepEqual(frames, []);
  assert.deepEqual(normalize({ type: 'session.message', message: {
    id: 'msg_catalog', type: 'system', text, time: { created: 1 },
    metadata: { notice: 'instructions', instructionSources: ['core/codemode'] },
  } }, 'app'), []);
});

test('mixed instruction updates and unrelated messages remain visible', () => {
  const frames: NormalizedMessage[] = [];
  const projector = new OpenCodeEventProjector(() => 'app', (frame) => frames.push(frame), normalize);
  projector.handle({ type: 'session.instructions.updated', id: 'evt_mixed', created: 1,
    durable: { aggregateID: 'ses_native', seq: 2, version: 2 },
    data: { sessionID: 'ses_native', delta: { 'core/codemode': 'hash', 'project/instructions': 'hash2' }, text: 'Mixed update' },
  } as OpenCodeEvent);
  assert.equal(frames[0].content, 'Mixed update');
  const metadata = { notice: 'instructions', instructionSources: ['core/codemode'] };
  const cases = [
    { type: 'system', text: 'MCP connection failed' },
    { type: 'system', text: 'Missing sources', metadata: { notice: 'instructions', instructionSources: [] } },
    { type: 'system', text: 'Connection failed', metadata, error: { message: 'MCP connection failed' } },
    { type: 'synthetic', text: 'Background done', metadata },
    { type: 'assistant', content: [{ type: 'text', text: 'The Code Mode tool catalog has changed.' }] },
  ];
  for (const message of cases) {
    assert.ok(normalize({ type: 'session.message', message: {
      id: 'msg_visible', time: { created: 1 }, ...message,
    } }, 'app').length > 0);
  }
});
