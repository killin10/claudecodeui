import assert from 'node:assert/strict';
import test from 'node:test';

import type { OpenCodeClient } from '@opencode/client';

import { OpenCodeSteering } from '@/modules/providers/list/opencode/opencode-steering.provider.js';

function fixture() {
  const prompts: any[] = [];
  const wakes: any[] = [];
  const errors: unknown[] = [];
  const uncertain: string[] = [];
  let respond = async (input: any) => ({ id: input.id, sessionID: input.sessionID });
  const steering = new OpenCodeSteering({
    client: () => ({ session: {
      prompt: async (input: any) => { prompts.push(input); return respond(input); },
      inbox: { update: async (input: any) => { wakes.push(input); } },
    } }) as unknown as OpenCodeClient,
    sessionId: () => 'ses_root', directory: '/tmp/project', signal: new AbortController().signal,
    settled: () => {}, fail: error => errors.push(error), notice: id => uncertain.push(id),
  });
  return { steering, prompts, wakes, errors, uncertain, response: (fn: typeof respond) => { respond = fn; } };
}

test('V2 steering preserves native IDs and attachments; duplicate requests share submission', async () => {
  const f = fixture();
  try {
    const options = { messageId: 'abc-def', files: [{ path: 'a.txt', name: 'a.txt' }] };
    await Promise.all([f.steering.send('change course', options), f.steering.send('change course', options)]);
    assert.equal(f.prompts.length, 1);
    assert.deepEqual(f.prompts[0], { sessionID: 'ses_root', id: 'msg_abcdef', text: 'change course',
      files: [{ uri: 'file:///tmp/project/a.txt', name: 'a.txt' }], delivery: 'steer' });
    assert.equal(f.steering.pending, true);
    f.steering.delivered('msg_abcdef');
    assert.equal(f.steering.messageId('msg_abcdef_0'), 'abc-def');
    assert.equal(f.steering.pending, false);
  } finally { f.steering.close(); }
});

test('V2 input stranded at a turn boundary is woken, never submitted twice', async () => {
  const f = fixture();
  try {
    await f.steering.send('continue', { messageId: 'one' });
    f.steering.wakePending();
    f.steering.wakePending();
    assert.deepEqual(f.wakes, [{ sessionID: 'ses_root', inboxID: 'msg_one', delivery: 'steer' }]);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.steering.pending, true);
    f.steering.delivered('msg_one');
    assert.equal(f.steering.pending, false);
  } finally { f.steering.close(); }
});

test('V2 delivery before HTTP response still correlates; unknown failures are never retried', async () => {
  const f = fixture();
  try {
    f.response(async input => {
      f.steering.delivered(input.id);
      throw new Error('response lost');
    });
    await assert.rejects(f.steering.send('once', { messageId: 'once' }), /response lost/);
    await assert.rejects(f.steering.send('once', { messageId: 'once' }), /response lost/);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.steering.messageId('msg_once_0'), 'once');
    assert.equal(f.steering.pending, false);
  } finally { f.steering.close(); }
});

test('V2 shutdown marks undelivered inbox items uncertain and ignores unrelated cancellation', async () => {
  const f = fixture();
  await f.steering.send('pending', { messageId: 'pending' });
  f.steering.cancelled('unrelated');
  assert.deepEqual(f.errors, []);
  f.steering.close();
  assert.deepEqual(f.uncertain, ['pending']);
});

test('cancelling a pending steer does not stop the parent task', async () => {
  const f = fixture();
  await f.steering.send('cancel me', { messageId: 'cancelled' });
  f.steering.cancelled('msg_cancelled');
  assert.equal(f.steering.pending, false);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.uncertain, ['cancelled']);
  f.steering.close();
  assert.equal(f.uncertain.length, 1);
});
