import assert from 'node:assert/strict';
import { test } from 'node:test';

import Database from 'better-sqlite3';
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

function nativeState() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, time_busy INTEGER, time_idle INTEGER, idle_outcome TEXT);
    CREATE TABLE session_message (session_id TEXT, type TEXT, seq INTEGER, data TEXT);
    INSERT INTO session_v2 VALUES ('ses_root', NULL, 30, 40, 'succeeded');
    INSERT INTO session_v2 VALUES ('ses_child', 'ses_root', 2, 20, 'succeeded');
  `);
  return db;
}

function deliver(db: Database.Database, at = 30) {
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)').run('ses_root', 'synthetic', 5,
    JSON.stringify({ time: { created: at }, metadata: { source: 'subagent', childID: 'ses_child', state: 'completed' } }));
}

test('missed terminal and delivery events reconcile from native state without resurrecting a stale snapshot', () => {
  const db = nativeState();
  try {
    const work = new OpenCodeBackgroundWork();
    work.track(message('call_one'), false);
    deliver(db);
    assert.equal(db.transaction(() => work.reconcile(db))(), true);
    assert.equal(work.pending, false);
    assert.deepEqual(work.runningTasks, []);
    work.track(message('call_one'), false);
    assert.equal(work.pending, false);
  } finally { db.close(); }
});

test('completed child waits for delivery and an unfinished parent followup without appearing as running', () => {
  const db = nativeState();
  try {
    const work = new OpenCodeBackgroundWork();
    work.track(message('call_one'), false);
    work.reconcile(db);
    assert.equal(work.pending, true);
    assert.deepEqual(work.runningTasks, []);
    deliver(db);
    db.exec("UPDATE session_v2 SET time_busy = 50 WHERE id = 'ses_root'");
    work.reconcile(db);
    assert.equal(work.pending, true);
    db.exec("UPDATE session_v2 SET time_idle = 60 WHERE id = 'ses_root'");
    work.reconcile(db);
    assert.equal(work.pending, false);
  } finally { db.close(); }
});

test('a new invocation and a restarted execution cannot be settled by old completion or delivery records', () => {
  const db = nativeState();
  try {
    const work = new OpenCodeBackgroundWork();
    const next = message('call_two');
    if (next.type === 'assistant' && next.content[0].type === 'tool') next.content[0].time.created = 50;
    work.track(next, false);
    deliver(db);
    work.notificationDelivered('ses_root', { source: 'subagent', childID: 'ses_child' }, 30);
    work.reconcile(db);
    assert.equal(work.runningTasks.length, 1);
    db.exec("UPDATE session_v2 SET time_busy = 70, time_idle = 60 WHERE id = 'ses_child'");
    work.reconcile(db);
    assert.equal(work.runningTasks.length, 1);
    assert.equal(work.pending, true);
  } finally { db.close(); }
});

test('read failure preserves pending background work', () => {
  const db = new Database(':memory:');
  try {
    const work = new OpenCodeBackgroundWork();
    work.track(message('call_one'), false);
    assert.throws(() => work.reconcile(db));
    assert.equal(work.pending, true);
    assert.equal(work.runningTasks.length, 1);
  } finally { db.close(); }
});

test('a child resumed by a recovered host becomes running again until its new completion', () => {
  const db = nativeState();
  try {
    const work = new OpenCodeBackgroundWork();
    work.track(message('call_one'), false);
    work.reconcile(db);
    assert.equal(work.runningTasks.length, 0);
    db.exec("UPDATE session_v2 SET time_busy = 50 WHERE id = 'ses_child'");
    work.reconcile(db);
    assert.equal(work.runningTasks.length, 1);
    deliver(db, 30);
    work.reconcile(db);
    assert.equal(work.pending, true);
  } finally { db.close(); }
});

test('delivery arriving before a new invocation snapshot cannot consume that invocation', () => {
  const work = new OpenCodeBackgroundWork();
  work.notificationDelivered('ses_root', { source: 'subagent', childID: 'ses_child' }, 20);
  const next = message('call_two');
  if (next.type === 'assistant' && next.content[0].type === 'tool') next.content[0].time.created = 50;
  work.track(next, false);
  assert.equal(work.runningTasks.length, 1);
  work.track(message('call_one'), false);
  assert.equal(work.runningTasks[0]?.toolUseId, 'call_two');
});

test('a delivery query failure does not partially apply a successful completion query', () => {
  const db = nativeState();
  try {
    db.exec('DROP TABLE session_message');
    const work = new OpenCodeBackgroundWork();
    work.track(message('call_one'), false);
    assert.throws(() => work.reconcile(db));
    assert.equal(work.runningTasks.length, 1);
  } finally { db.close(); }
});
