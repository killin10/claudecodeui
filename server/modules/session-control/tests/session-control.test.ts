import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { apiKeysDb, closeConnection, getConnection, initializeDatabase, sessionControlDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

import { sessionControlService } from '../session-control.service.js';
import { createSubmissionDispatcher } from '../session-submissions.service.js';
import { createSessionControlRouter } from '../session-control.routes.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-control-'));
  const old = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  closeConnection();
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const userId = Number(userDb.createUser('test', 'hash').id);
  const models = providerModelsService.getProviderModels;
  const running = sessionsService.listRunningSessions;
  providerModelsService.getProviderModels = async () => ({ DEFAULT: 'test-model', OPTIONS: [{ value: 'test-model', label: 'Test' }] });
  sessionsService.listRunningSessions = async () => chatRunRegistry.listRunningRuns();
  t.after(async () => {
    providerModelsService.getProviderModels = models;
    sessionsService.listRunningSessions = running;
    closeConnection();
    if (old === undefined) {
      delete process.env.DATABASE_PATH;
    }
    else {
      process.env.DATABASE_PATH = old;
    }
    await rm(root, { recursive: true, force: true });
  });
  const create = (extra = {}) => sessionControlService.create(userId, { provider: 'codex', projectPath: root, ...extra });
  return { root, userId, create };
}

function fakeRuntime(overrides: Partial<ProviderRuntimeGateway> = {}): ProviderRuntimeGateway {
  return {
    hasRuntime: () => true,
    steer: async () => false,
    askSideQuestion: async () => ({ status: 'done', answer: 'test answer' }), hasBackgroundWork: () => false,
    getPendingApprovalsForSession: () => [], resolveToolApproval() { },
    abort: async () => true, stopBackgroundTask: async () => false,
    run: async (provider, content, options, writer) => {
      writer.send(createNormalizedMessage({ provider, sessionId: String(options.sessionId), kind: 'text', role: 'assistant', content: 'reply: ' + content }));
      writer.send(createCompleteMessage({ provider, sessionId: String(options.sessionId), exitCode: 0 }));
    }, ...overrides,
  };
}

async function eventually(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Condition did not become true');
}

test('create uses named settings, rejects bad models, and deduplicates even after permanent deletion', async (t) => {
  const { create, userId, root } = await fixture(t);
  await assert.rejects(create({ model: 'missing' }), /catalog/);
  await assert.rejects(create({ projectPath: 'relative' }), /absolute/);
  const a = await create({ clientToken: 'create-1', title: 'Full custom title stays intact', permissionMode: 'bypass-permissions' });
  assert.ok(a);
  const b = await create({ clientToken: 'create-1', title: 'Full custom title stays intact', permissionMode: 'bypass-permissions' });
  assert.deepEqual(b, a);
  assert.equal(a.permissionMode, 'bypass-permissions');
  await assert.rejects(create({ clientToken: 'create-1', title: 'different' }), /different input/);
  await sessionControlService.change(userId, a.sessionId, 'archive');
  await assert.rejects(sessionControlService.send(userId, a.sessionId, { message: 'hello' }), /Restore/);
  await sessionControlService.change(userId, a.sessionId, 'restore');
  await sessionControlService.change(userId, a.sessionId, 'delete');
  assert.equal(sessionsDb.getSessionById(a.sessionId), null);
  await assert.rejects(create({ clientToken: 'create-1', title: a.title, permissionMode: 'bypass-permissions' }), /permanently deleted/);
  assert.equal(sessionControlDb.receipt(userId, 'create', 'create-1')?.response.includes(a.title!), false);
  assert.equal((await sessionControlService.list(userId, { projectPath: root })).items.length, 0);
});

test('listing paginates within filters and rejects reuse with another filter', async (t) => {
  const { create, userId } = await fixture(t);
  await create({ title: 'needle one' });
  await create({ title: 'needle two' });
  await create({ title: 'unrelated' });
  const first = await sessionControlService.list(userId, { search: 'needle', maxItems: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextToken);
  const second = await sessionControlService.list(userId, { search: 'needle', maxItems: 1, startingToken: first.nextToken });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextToken, null);
  assert.notEqual(first.items[0].sessionId, second.items[0].sessionId);
  await assert.rejects(sessionControlService.list(userId, { search: 'different', startingToken: first.nextToken }), /Invalid starting-token/);
  const plan = getConnection().prepare("EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE isArchived=0 ORDER BY updated_at DESC,session_id DESC LIMIT 10").all();
  assert.match(JSON.stringify(plan), /sessions_control_listing/);
});

test('messages persist, execute once, return their own result and survive failed response retries', async (t) => {
  const { create, userId } = await fixture(t);
  const session = await create();
  assert.ok(session);
  let calls = 0;
  const base = fakeRuntime();
  const dispatcher = createSubmissionDispatcher(fakeRuntime({ run: async (...args) => { calls++; return base.run(...args); } }));
  const row = await sessionControlService.send(userId, session.sessionId, { message: 'hello', clientToken: 'message-1' });
  assert.deepEqual(await sessionControlService.send(userId, session.sessionId, { message: 'hello', clientToken: 'message-1' }), row);
  await dispatcher.poll();
  await eventually(() => sessionControlDb.get(row.submissionId, userId)?.state === 'succeeded');
  await dispatcher.poll();
  const result = sessionControlService.submission(userId, session.sessionId, row.submissionId);
  assert.equal(calls, 1);
  assert.equal(result.result[0].content, 'reply: hello');
  assert.throws(() => sessionControlService.submission(userId + 1, session.sessionId, row.submissionId), /not found/);
});

test('queued cancellation and restart recovery do not replay active submissions', async (t) => {
  const { create, userId } = await fixture(t);
  const session = await create();
  assert.ok(session);
  const dispatcher = createSubmissionDispatcher(fakeRuntime());
  const a = await sessionControlService.send(userId, session.sessionId, { message: 'a' });
  await assert.rejects(sessionControlService.change(userId, session.sessionId, 'archive'), /pending messages/);
  await dispatcher.cancel(userId, session.sessionId, a.submissionId);
  await dispatcher.poll();
  assert.equal(sessionControlDb.get(a.submissionId, userId)?.state, 'cancelled');
  const b = await sessionControlService.send(userId, session.sessionId, { message: 'b' });
  sessionControlDb.transition(b.submissionId, ['queued'], 'running');
  sessionControlDb.recover();
  await dispatcher.poll();
  assert.equal(sessionControlDb.get(b.submissionId, userId)?.state, 'interrupted');
});

test('background work blocks queued sends and active cancellation does not abort a newer run', async (t) => {
  const { create, userId } = await fixture(t);
  const session = await create();
  assert.ok(session);
  let release!: () => void;
  let background = true;
  let aborts = 0;
  const dispatcher = createSubmissionDispatcher(fakeRuntime({ hasBackgroundWork: () => background, run: async () => new Promise<void>((resolve) => { release = resolve; }), abort: async () => { aborts++; release(); return true; } }));
  const a = await sessionControlService.send(userId, session.sessionId, { message: 'a' });
  await dispatcher.poll();
  assert.equal(sessionControlDb.get(a.submissionId, userId)?.state, 'queued');
  background = false;
  await dispatcher.poll();
  assert.equal(sessionControlDb.get(a.submissionId, userId)?.state, 'running');
  await dispatcher.cancel(userId, session.sessionId, a.submissionId);
  assert.equal(aborts, 1);
  assert.equal(sessionControlDb.get(a.submissionId, userId)?.state, 'cancelled');
  await eventually(() => !chatRunRegistry.isProcessing(session.sessionId));
  await dispatcher.cancel(userId, session.sessionId, a.submissionId);
  assert.equal(aborts, 1);
});

test('silent runtime exit is failed, and a provider error followed by exit 0 stays failed', async (t) => {
  const { create, userId } = await fixture(t);
  for (const withError of [false, true]) {
    const session = await create();
    assert.ok(session);
    const dispatcher = createSubmissionDispatcher(fakeRuntime({ run: async (provider, _content, _options, writer) => {
        if (withError) {
          writer.send(createNormalizedMessage({ provider, kind: 'error', content: 'broken' }));
          writer.send(createCompleteMessage({ provider, exitCode: 0 }));
        }
      } }));
    const row = await sessionControlService.send(userId, session.sessionId, { message: 'hello' });
    await dispatcher.poll();
    await eventually(() => sessionControlDb.get(row.submissionId, userId)?.state === 'failed');
  }
});

test('real CLI talks to authenticated HTTP API without bootstrapping server environment', async (t) => {
  const { create, userId, root } = await fixture(t);
  const session = await create();
  assert.ok(session);
  const key = apiKeysDb.createApiKey(userId, 'fixture').apiKey;
  const dispatcher = createSubmissionDispatcher(fakeRuntime());
  const app = express().use(express.json()).use('/api/session-control/v1', createSessionControlRouter(dispatcher));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const unauth = await fetch(endpoint + '/api/session-control/v1/sessions');
  assert.equal(unauth.status, 401);
  const call = (args: string[]) => new Promise<{
    code: number | null;
    out: string;
    err: string;
  }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/modules/cli/cli.ts', 'session', ...args, '--endpoint', endpoint], {
      env: { ...process.env, HOME: root, CLOUDCLI_API_KEY: key },
    });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => out += chunk);
    child.stderr.on('data', (chunk) => err += chunk);
    child.on('close', (code) => resolve({ code, out, err }));
  });
  const listed = await call(['list', '--max-items', '1', '--query', 'items[0].sessionId', '--output', 'tsv']);
  assert.equal(listed.code, 0, listed.err);
  assert.equal(listed.out.trim(), session.sessionId);
  assert.equal(listed.err, '');
  const bad = await call(['show', session.sessionId]);
  assert.equal(bad.code, 2);
  assert.equal(bad.out, '');
  await writeFile(path.join(root, 'message.txt'), 'hello');
  const sent = await call(['send', '--session-id', session.sessionId, '--message-file', path.join(root, 'message.txt'), '--client-token', 'http-send']);
  assert.equal(sent.code, 0, sent.err);
  const submissionId = JSON.parse(sent.out).submissionId;
  const waited = await call(['submission', 'wait', '--session-id', session.sessionId, '--submission-id', submissionId, '--timeout-seconds', '2']);
  assert.equal(waited.code, 0, waited.err);
  assert.equal(JSON.parse(waited.out).result[0].content, 'reply: hello');
  const archived = await call(['archive', '--session-id', session.sessionId]);
  assert.equal(archived.code, 0, archived.err);
  const deleted = await call(['delete', '--session-id', session.sessionId, '--permanent']);
  assert.equal(deleted.code, 0, deleted.err);
  const missing = await call(['show', '--session-id', session.sessionId]);
  assert.equal(missing.code, 3);
  assert.equal(missing.out, '');
});

test('mutation reservations prevent a new UI run from starting during native deletion', async (t) => {
  const { create, userId } = await fixture(t);
  const session = await create();
  assert.ok(session);
  const original = sessionsService.deleteOrArchiveSessionById;
  sessionsService.deleteOrArchiveSessionById = async (...args) => {
    assert.equal(chatRunRegistry.startRun({ appSessionId: session.sessionId, provider: 'codex', providerSessionId: null, connection: null, userId }), null);
    return original(...args);
  };
  try {
    await sessionControlService.change(userId, session.sessionId, 'delete');
  }
  finally {
    sessionsService.deleteOrArchiveSessionById = original;
  }
  assert.equal(chatRunRegistry.isMutationReserved(session.sessionId), false);
});

test('queue preserves FIFO order for multiple submissions and snapshots permission mode', async (t) => {
  const { create, userId } = await fixture(t);
  const session = await create({ permissionMode: 'bypass-permissions' });
  assert.ok(session);
  const order: string[] = [];
  const base = fakeRuntime();
  const dispatcher = createSubmissionDispatcher(fakeRuntime({ run: async (...args) => {
      order.push(args[1]);
      assert.equal(args[2].permissionMode, 'bypassPermissions');
      return base.run(...args);
    } }));
  const a = await sessionControlService.send(userId, session.sessionId, { message: 'first' });
  const b = await sessionControlService.send(userId, session.sessionId, { message: 'second' });
  sessionsDb.setPermissionMode(session.sessionId, 'default');
  await dispatcher.poll();
  await eventually(() => sessionControlDb.get(a.submissionId, userId)?.state === 'succeeded');
  await dispatcher.poll();
  await eventually(async () => { await dispatcher.poll(); return sessionControlDb.get(b.submissionId, userId)?.state === 'succeeded'; });
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(sessionsDb.getPermissionMode(session.sessionId), 'default');
});

test('overlapping approval requests stay waiting until all have resolved', async (t) => {
  const { create, userId } = await fixture(t);
  const session = await create();
  let respond!: () => void;
  const dispatcher = createSubmissionDispatcher(fakeRuntime({ run: async (provider, _text, _options, writer) => {
    writer.send(createNormalizedMessage({ provider, kind: 'permission_request', requestId: 'one' }));
    writer.send(createNormalizedMessage({ provider, kind: 'permission_request', requestId: 'two' }));
    writer.send(createNormalizedMessage({ provider, kind: 'permission_resolved', requestId: 'one' }));
    await new Promise<void>((resolve) => { respond = resolve; });
    writer.send(createNormalizedMessage({ provider, kind: 'permission_resolved', requestId: 'two' }));
    writer.send(createCompleteMessage({ provider, exitCode: 0 }));
  } }));
  const row = await sessionControlService.send(userId, session.sessionId, { message: 'ask' });
  await dispatcher.poll();
  assert.equal(sessionControlDb.get(row.submissionId, userId)?.state, 'waiting-for-input');
  respond();
  await eventually(() => sessionControlDb.get(row.submissionId, userId)?.state === 'succeeded');
});


test('temporary submission overrides execute without changing session defaults', async (t) => {
  const { create, userId } = await fixture(t);
  const session = await create({ permissionMode: 'default' });
  sessionsDb.setSessionEffort(session.sessionId, 'high');
  const base = fakeRuntime();
  const dispatcher = createSubmissionDispatcher(fakeRuntime({ run: async (...args) => {
    assert.equal(args[2].permissionMode, 'plan');
    assert.equal(args[2].model, 'temporary-model');
    return base.run(...args);
  } }));
  const submission = sessionControlService.enqueue(userId, session.sessionId, 'temporary run', {
    permissionMode: 'plan', model: 'temporary-model',
  });
  await dispatcher.poll();
  await eventually(() => sessionControlDb.get(submission.submissionId, userId)?.state === 'succeeded');
  const saved = sessionsDb.getSessionById(session.sessionId)!;
  assert.equal(saved.permission_mode, 'default');
  assert.equal(saved.model, 'test-model');
  assert.equal(saved.effort, 'high');
  const next = sessionControlService.enqueue(userId, session.sessionId, 'inherit');
  assert.deepEqual(sessionControlDb.get(next.submissionId, userId)?.options, {
    permissionMode: 'default', model: 'test-model',
  });
});
