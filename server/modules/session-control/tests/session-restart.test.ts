import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { closeConnection, getConnection, initializeDatabase, sessionsDb, sessionControlDb, userDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { createNormalizedMessage } from '@/shared/utils.js';

import { resumeSessionsAfterRestart, stopSessionsForRestart } from '../session-restart.service.js';
import { createSubmissionDispatcher } from '../session-submissions.service.js';
import { sessionControlService } from '../session-control.service.js';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-restart-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'test.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const userId = Number(userDb.createUser('owner', 'test-hash').id);
  const history = sessionsService.fetchHistory;
  const running = sessionsService.listRunningSessions;
  sessionsService.fetchHistory = async () => ({
    messages: [createNormalizedMessage({ provider: 'codex', kind: 'text', role: 'user', content: 'Original task' })],
    total: 1, hasMore: false, offset: 0, limit: 1,
  });
  sessionsService.listRunningSessions = async () => chatRunRegistry.listRunningRuns();
  t.after(async () => {
    sessionsService.fetchHistory = history;
    sessionsService.listRunningSessions = running;
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  });
  function create(id: string, native = true) {
    sessionsDb.createAppSession(id, 'codex', directory);
    if (native) sessionsDb.assignProviderSessionId(id, `native-${id}`);
  }
  function run(id: string) {
    create(id);
    return chatRunRegistry.startRun({ appSessionId: id, provider: 'codex', providerSessionId: `native-${id}`, connection: null, userId })!;
  }
  return { userId, create, run };
}

function runtime(overrides: Partial<ProviderRuntimeGateway> = {}): ProviderRuntimeGateway {
  return {
    hasRuntime: () => true,
    steer: async () => false,
    askSideQuestion: async () => ({ status: 'done', answer: 'test answer' }), hasBackgroundWork: () => false,
    getPendingApprovalsForSession: () => [], resolveToolApproval() {},
    stopBackgroundTask: async () => false,
    abort: async (_provider, id) => {
      chatRunRegistry.completeRun(id, { exitCode: 0, aborted: true });
      return true;
    },
    run: async (_provider, _command, _options, writer) => { writer.send({ kind: 'complete', exitCode: 0 }); },
    ...overrides,
  };
}

test('migration assigns existing/imported/forked sessions, preserves pending native IDs, removes metrics idempotently', async t => {
  const { userId, create } = await fixture(t);
  create('pending', false);
  sessionsDb.createSession('imported', 'codex', '/tmp/project');
  sessionsDb.createForkedSession({ sessionId: 'fork', provider: 'codex', projectPath: '/tmp/project', customName: null,
    providerSessionId: 'native-fork', jsonlPath: null, forkedFromSessionId: 'imported', model: null, effort: null });
  getConnection().exec(`
    DROP TRIGGER sessions_assign_owner;
    DROP TRIGGER sessions_assign_first_user;
    ALTER TABLE sessions DROP COLUMN user_id;
    ALTER TABLE sessions DROP COLUMN resume_after_restart;
    CREATE TABLE compaction_metrics (session_id TEXT);
    CREATE TABLE session_names (session_id TEXT, provider TEXT, custom_name TEXT, created_at TEXT, updated_at TEXT);
    INSERT INTO session_names VALUES ('legacy', 'codex', 'Legacy session', NULL, NULL);
  `);
  await initializeDatabase();
  await initializeDatabase();
  for (const id of ['pending', 'imported', 'fork', 'legacy']) assert.equal(sessionsDb.getSessionById(id)?.user_id, userId);
  assert.equal(sessionsDb.getSessionById('pending')?.provider_session_id, null);
  assert.equal(sessionsDb.getSessionById('legacy')?.provider_session_id, 'legacy');
  assert.equal(getConnection().prepare("SELECT 1 FROM sqlite_master WHERE name='compaction_metrics'").get(), undefined);
});

test('normal restart persists only active main turns and enqueues one continuation on repeated startup', async t => {
  const { run, create } = await fixture(t);
  run('active');
  const waiting = run('waiting');
  waiting.writer.send({ kind: 'permission_request', requestId: 'approval' });
  run('cancelling').userCancelling = true;
  run('cancelled');
  chatRunRegistry.completeRun('cancelled', { exitCode: 0, aborted: true });
  run('finished');
  chatRunRegistry.completeRun('finished', { exitCode: 0 });
  create('external');
  await stopSessionsForRestart(runtime());
  assert.deepEqual(sessionsDb.listRestartSessions().map(row => row.session_id), ['active']);
  assert.equal(chatRunRegistry.isAcceptingRuns(), false);
  closeConnection();
  chatRunRegistry.clearAll();
  await initializeDatabase();
  await resumeSessionsAfterRestart();
  await resumeSessionsAfterRestart();
  const queued = sessionControlDb.queued();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].sessionId, 'active');
  assert.match(queued[0].content, /服务重启中断/);
  assert.equal(sessionsDb.listRestartSessions().length, 0);
});

test('natural completion after snapshot clears recovery, resolved approvals are eligible', async t => {
  const { run } = await fixture(t);
  const active = run('active');
  active.writer.send({ kind: 'permission_request', requestId: 'p' });
  active.writer.send({ kind: 'permission_resolved', requestId: 'p' });
  chatRunRegistry.saveRestartCandidates(() => false);
  assert.equal(sessionsDb.listRestartSessions().length, 1);
  active.writer.send({ kind: 'complete', exitCode: 0 });
  assert.equal(sessionsDb.listRestartSessions().length, 0);
});

test('archived, deleted and uninitialized sessions do not become new conversations', async t => {
  const { create } = await fixture(t);
  for (const id of ['archived', 'deleted', 'pending', 'missing-history']) {
    create(id, id !== 'pending');
    sessionsDb.setResumeAfterRestart(id, true);
  }
  sessionsDb.updateSessionIsArchived('archived', true);
  sessionsDb.deleteSessionById('deleted');
  sessionsService.fetchHistory = async () => ({ messages: [], total: 0, hasMore: false, offset: 0, limit: 1 });
  await resumeSessionsAfterRestart();
  assert.equal(sessionControlDb.queued().length, 0);
  assert.equal(sessionsDb.listRestartSessions().length, 0);
});

test('ready follow-up replaces continuation while a future scheduled message does not', async t => {
  const { create, userId } = await fixture(t);
  create('ready');
  create('future');
  sessionControlService.enqueue(userId, 'ready', 'User follow-up');
  getConnection().prepare(`INSERT INTO scheduled_messages(id,user_id,session_id,content,scheduled_for)
    VALUES('later',?,'future','Future task','2099-01-01T00:00:00Z')`).run(userId);
  sessionsDb.setResumeAfterRestart('ready', true);
  sessionsDb.setResumeAfterRestart('future', true);
  await resumeSessionsAfterRestart();
  assert.deepEqual(sessionControlDb.queued().map(row => row.sessionId).sort(), ['future', 'ready']);
});

test('enqueue failure rolls back marker clearing and any partial submission', async t => {
  const { create } = await fixture(t);
  create('retry');
  sessionsDb.setResumeAfterRestart('retry', true);
  const enqueue = sessionControlService.enqueue;
  sessionControlService.enqueue = (...args) => { enqueue(...args); throw new Error('Simulated persistence failure'); };
  try {
    await resumeSessionsAfterRestart();
    assert.equal(sessionControlDb.queued().length, 0);
    assert.equal(sessionsDb.getSessionById('retry')?.resume_after_restart, 1);
  } finally { sessionControlService.enqueue = enqueue; }
  await resumeSessionsAfterRestart();
  assert.equal(sessionControlDb.queued().length, 1);
});

test('continuation executes through existing dispatcher without a browser, preserving model and permissions', async t => {
  const { create, userId } = await fixture(t);
  create('resume');
  sessionsDb.setSessionModel('resume', 'test-model');
  sessionsDb.setPermissionMode('resume', 'bypassPermissions');
  sessionsDb.setResumeAfterRestart('resume', true);
  await resumeSessionsAfterRestart();
  const row = sessionControlDb.queued()[0];
  let calls = 0;
  const fake = runtime({ run: async (_provider, command, options, writer) => {
    calls++;
    assert.match(command, /服务重启中断/);
    assert.equal(options.sessionId, 'resume');
    assert.equal(options.model, 'test-model');
    assert.equal(options.permissionMode, 'bypassPermissions');
    writer.send({ kind: 'complete', exitCode: 0 });
  } });
  const dispatcher = createSubmissionDispatcher(fake);
  await dispatcher.poll();
  await new Promise(resolve => setTimeout(resolve, 20));
  dispatcher.close();
  assert.equal(calls, 1);
  assert.equal(sessionControlDb.get(row.submissionId, userId)?.state, 'succeeded');
  chatRunRegistry.setAcceptingRuns(false);
  const result = await runDetachedChatTurn({ sessionId: 'resume', userId, content: 'should not run' }, { runtime: fake });
  assert.equal(result.started, false);
  assert.equal(calls, 1);
});

test('a separate process saves on SIGTERM and a new process consumes the marker once', async t => {
  const { create } = await fixture(t);
  create('process-restart');
  const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
  const imports = `
    const { initializeDatabase, sessionsDb, sessionControlDb } = await import(${moduleUrl('server/modules/database/index.ts')});
    const { chatRunRegistry } = await import(${moduleUrl('server/modules/websocket/index.ts')});
    const { sessionsService } = await import(${moduleUrl('server/modules/providers/index.ts')});
    const { stopSessionsForRestart, resumeSessionsAfterRestart } = await import(${moduleUrl('server/modules/session-control/session-restart.service.ts')});
    await initializeDatabase();
  `;
  async function child(script: string, stopWhenReady: boolean) {
    const processChild = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', imports + script], {
      env: { ...process.env, TSX_TSCONFIG_PATH: path.resolve('server/tsconfig.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let signalled = false;
    processChild.stdout.on('data', chunk => {
      output += chunk;
      if (stopWhenReady && !signalled && output.includes('READY_FOR_STOP')) {
        signalled = true;
        processChild.kill('SIGTERM');
      }
    });
    processChild.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => processChild.kill('SIGKILL'), 15000);
    try {
      await new Promise<void>((resolve, reject) => {
        processChild.on('error', reject);
        processChild.on('exit', (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`Child failed (${code}/${signal}): ${output}`));
        });
      });
    } finally { clearTimeout(timer); }
  }
  await child(`
    chatRunRegistry.startRun({ appSessionId: 'process-restart', provider: 'codex', providerSessionId: 'native-process-restart', connection: null, userId: 1 });
    process.on('SIGTERM', async () => {
      await stopSessionsForRestart({ getPendingApprovalsForSession: () => [], abort: async () => true });
      process.exit(0);
    });
    setInterval(() => {}, 1000);
    console.log('READY_FOR_STOP');
  `, true);
  assert.equal(sessionsDb.getSessionById('process-restart')?.resume_after_restart, 1);
  await child(`
    sessionsService.fetchHistory = async () => ({ messages: [{kind:'text', content:'task'}], total:1 });
    await resumeSessionsAfterRestart();
    await resumeSessionsAfterRestart();
    process.exit(0);
  `, false);
  assert.equal(sessionsDb.getSessionById('process-restart')?.resume_after_restart, 0);
  assert.equal(sessionControlDb.queued().filter(row => row.sessionId === 'process-restart').length, 1);
});
