import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  apiKeysDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  schedulesDb,
  sessionControlDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import {
  createSubmissionDispatcher,
  sessionControlService,
} from '@/modules/session-control/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

import { schedulesService, dispatchSchedules } from '../schedules.service.js';
import { createSchedulesRouter } from '../schedules.routes.js';
import { startScheduleDispatcher, closeScheduleDispatcher } from '../schedule-dispatcher.js';

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'schedules-'));
  const before = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const user = Number(userDb.createUser('schedule-test', 'hash').id);
  const id = 'schedule-session';
  sessionsDb.createAppSession(id, 'codex', home, 'Fixture');
  t.mock.method(providerModelsService, 'getProviderModels', async () => ({
    DEFAULT: 'fixture',
    OPTIONS: [{ value: 'fixture', label: 'Fixture' }],
  }));
  t.mock.method(sessionsService, 'listRunningSessions', async () =>
    chatRunRegistry.listRunningRuns(),
  );
  t.after(async () => {
    closeConnection();
    if (before === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = before;
    await rm(home, { recursive: true, force: true });
  });
  const create = (extra: Record<string, unknown> = {}) =>
    schedulesService.create(user, {
      name: 'Daily task',
      sessionId: id,
      message: 'Inspect only',
      cron: '* * * * *',
      timezone: 'Asia/Shanghai',
      ...extra,
    });
  return { user, id, create, home };
}

test('cron preview uses explicit timezone, validates input, and handles calendar boundaries', () => {
  const base = new Date('2030-01-04T02:00:00Z'); // Friday in Shanghai.
  const p = schedulesService.preview({ cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai' }, base);
  assert.equal(p.times[0], '2030-01-07T01:00:00.000Z');
  assert.equal(p.times.length, 5);
  assert.throws(() => schedulesService.preview({ cron: '0 * * * * *', timezone: 'UTC' }), /five/);
  assert.throws(
    () => schedulesService.preview({ cron: '* * * * *', timezone: 'Wrong/Zone' }),
    /IANA/,
  );
  assert.throws(() => schedulesService.preview({ cron: '0 0 30 2 *', timezone: 'UTC' }), /cron/);
  assert.throws(
    () => schedulesService.preview({ runAt: '2030-01-01T10:00', timezone: 'UTC' }),
    /offset/,
  );
  assert.throws(() => schedulesService.preview({ runAt: '2030-02-30T09:00:00Z', timezone: 'UTC' }), /calendar/);
  const dst = schedulesService.preview(
    { cron: '0 9 * * *', timezone: 'America/New_York' },
    new Date('2030-03-09T15:00:00Z'),
  );
  assert.equal(dst.times[0], '2030-03-10T13:00:00.000Z');
});

test('trigger is atomic, deduplicated and snapshots settings; next overlap is recorded without enqueue', async (t) => {
  const { user, id, create } = await fixture(t);
  const task = await create({ model: 'fixture', permissionMode: 'plan' });
  const time = new Date(task.nextRunAt!);
  assert.equal(dispatchSchedules(time), 1);
  assert.equal(dispatchSchedules(time), 0);
  const first = schedulesService.runs(user, task.scheduleId, {}).items[0];
  assert.equal(first.state, 'queued');
  const submission = sessionControlDb.get(first.submissionId!, user)!;
  assert.equal(submission.options.model, 'fixture');
  assert.equal(submission.options.permissionMode, 'plan');
  assert.equal(sessionControlDb.permission(id), null);
  const edited = await schedulesService.update(user, task.scheduleId, {
    revision: schedulesDb.get(task.scheduleId)!.revision,
    message: 'Changed future message',
  });
  assert.equal(
    schedulesService.execution(user, task.scheduleId, first.runId).submission?.content,
    'Inspect only',
  );
  assert.notEqual(edited.nextRunAt, task.nextRunAt);
  dispatchSchedules(new Date(edited.nextRunAt!));
  assert.equal(sessionControlDb.pending(id), 1);
  assert.ok(
    schedulesService.runs(user, task.scheduleId, {}).items.some((r) => r.state === 'skipped'),
  );
});

test('failed persistence rolls back both enqueue and schedule progression', async (t) => {
  const { id, create } = await fixture(t);
  const task = await create();
  const add = t.mock.method(schedulesDb, 'addRun', () => {
    throw new Error('disk failure');
  });
  assert.equal(dispatchSchedules(new Date(task.nextRunAt!)), 0);
  assert.equal(sessionControlDb.pending(id), 0);
  assert.equal(schedulesDb.get(task.scheduleId)!.nextRunAt, task.nextRunAt);
  add.mock.restore();
  assert.equal(dispatchSchedules(new Date(task.nextRunAt!)), 1);
});

test('outages skip or coalesce to latest, one-time tasks finish, resume never replays paused intervals', async (t) => {
  const { user, create } = await fixture(t);
  const skip = await create();
  const latest = await create({ misfirePolicy: 'latest' });
  const now = new Date(Date.parse(skip.nextRunAt!) + 3600000);
  dispatchSchedules(now);
  assert.equal(schedulesService.runs(user, skip.scheduleId, {}).items[0].state, 'skipped');
  const caught = schedulesService.runs(user, latest.scheduleId, {}).items;
  assert.equal(caught.length, 1);
  assert.equal(caught[0].scheduledFor, now.toISOString());
  const once = await create({ cron: null, runAt: new Date(Date.now() + 60000).toISOString() });
  dispatchSchedules(new Date(once.nextRunAt!));
  assert.equal(schedulesDb.get(once.scheduleId)!.enabled, false);
  schedulesService.change(user, skip.scheduleId, 'pause');
  assert.equal(schedulesDb.get(skip.scheduleId)!.nextRunAt, null);
  const resumed = schedulesService.change(user, skip.scheduleId, 'resume');
  assert.ok(Date.parse(resumed.nextRunAt!) > Date.now());
});

test('ownership, revision conflicts, idempotency, lifecycle and permanent content cleanup', async (t) => {
  const { user, id, create } = await fixture(t);
  const a = await create({ clientToken: 'create-token' });
  assert.deepEqual(await create({ clientToken: 'create-token' }), a);
  await assert.rejects(create({ clientToken: 'create-token', name: 'Other' }), /different input/);
  assert.throws(() => schedulesService.change(user + 1, a.scheduleId, 'pause'), /not found/);
  await assert.rejects(
    schedulesService.update(user, a.scheduleId, { revision: 0, name: 'Stale' }),
    /changed/,
  );
  await assert.rejects(create({ sessionId: 'missing' }), /not found/);
  await assert.rejects(create({ model: 'absent' }), /catalog/);
  const manual = schedulesService.run(user, a.scheduleId, { clientToken: 'manual-1' });
  assert.deepEqual(schedulesService.run(user, a.scheduleId, { clientToken: 'manual-1' }), manual);
  assert.throws(() => schedulesService.run(user, a.scheduleId), /previous/);
  schedulesService.change(user, a.scheduleId, 'pause');
  assert.equal(sessionControlDb.get(manual.submissionId!, user)!.state, 'queued');
  getConnection().prepare('UPDATE sessions SET isArchived=1 WHERE session_id=?').run(id);
  assert.equal(schedulesDb.get(a.scheduleId)!.enabled, false);
  getConnection().prepare('UPDATE sessions SET isArchived=0 WHERE session_id=?').run(id);
  assert.equal(schedulesDb.get(a.scheduleId)!.enabled, false);
  schedulesService.change(user, a.scheduleId, 'delete');
  assert.ok(schedulesService.execution(user, a.scheduleId, manual.runId));
  await assert.rejects(create({ clientToken: 'create-token' }), /deleted/);
  getConnection().prepare('DELETE FROM sessions WHERE session_id=?').run(id);
  assert.equal(schedulesDb.get(a.scheduleId), null);
  assert.equal(schedulesDb.run(manual.runId), null);
  assert.equal(sessionControlDb.get(manual.submissionId!, user), null);
  assert.ok(
    !sessionControlDb
      .receipt(user, 'schedule.create', 'create-token')!
      .response.includes('Inspect only'),
  );
});

test('submission result, restart interruption and queue cancellation are visible as execution state', async (t) => {
  const { user, create } = await fixture(t);
  const task = await create();
  const manual = schedulesService.run(user, task.scheduleId);
  const dispatcher = createSubmissionDispatcher({
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval() {},
    abort: async () => true,
    stopBackgroundTask: async () => false,
    run: async (provider, _content, options, writer) => {
      writer.send(
        createNormalizedMessage({
          provider,
          sessionId: String(options.sessionId),
          role: 'assistant',
          kind: 'text',
          content: 'Scheduled answer',
        }),
      );
      writer.send(
        createCompleteMessage({ provider, sessionId: String(options.sessionId), exitCode: 0 }),
      );
    },
  });
  await dispatcher.poll();
  for (let i = 0; i < 100 && sessionControlDb.pending(task.sessionId); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const result = schedulesService.execution(user, task.scheduleId, manual.runId);
  assert.equal(result.state, 'succeeded');
  assert.match(JSON.stringify(result.submission?.result), /Scheduled answer/);
  const next = schedulesService.run(user, task.scheduleId);
  sessionControlDb.transition(next.submissionId!, ['queued'], 'running');
  sessionControlDb.recover();
  assert.equal(schedulesService.execution(user, task.scheduleId, next.runId).state, 'interrupted');
  const queued = schedulesService.run(user, task.scheduleId);
  assert.equal(
    (await schedulesService.cancel(user, task.scheduleId, queued.runId)).state,
    'cancelled',
  );
});

test('API authenticates CLI keys and browser users, rejects unknown fields, paginates and isolates owners', async (t) => {
  const { user, create } = await fixture(t);
  const key = apiKeysDb.createApiKey(user, 'fixture').apiKey;
  await create();
  await create();
  const app = express();
  app.use(express.json());
  app.use('/schedules', createSchedulesRouter());
  app.use(
    '/browser',
    (req, _res, next) => {
      Object.assign(req, { user: { id: user } });
      next();
    },
    createSchedulesRouter(true),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(url + '/schedules')).status, 401);
  const headers = { 'x-api-key': key };
  const first = (await (await fetch(url + '/schedules?maxItems=1', { headers })).json()) as {
    items: { scheduleId: string }[];
    nextToken: string;
  };
  assert.equal(first.items.length, 1);
  assert.ok(first.nextToken);
  const second = (await (
    await fetch(url + '/schedules?maxItems=1&startingToken=' + first.nextToken, { headers })
  ).json()) as { items: { scheduleId: string }[] };
  assert.notEqual(second.items[0].scheduleId, first.items[0].scheduleId);
  assert.equal((await fetch(url + '/schedules?unknown=1', { headers })).status, 400);
  assert.equal((await fetch(url + '/browser')).status, 200);
});

test('installed-shape CLI manages schedules through HTTP and returns actual execution state', async (t) => {
  const { user, id, home } = await fixture(t);
  const key = apiKeysDb.createApiKey(user, 'schedule-cli').apiKey;
  const app = express().use(express.json()).use('/api/session-control/v1/schedules', createSchedulesRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const call = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/modules/cli/cli.ts', 'schedule', ...args,
      '--endpoint', `http://127.0.0.1:${address.port}`], {
      env: { ...process.env, HOME: home, CLOUDCLI_API_KEY: key }, timeout: 15000,
    });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
  const created = await call(['create', '--name', 'CLI task', '--session-id', id, '--cron', '0 9 * * 1-5', '--timezone', 'UTC', '--message', 'Inspect only', '--client-token', 'cli-create']);
  assert.equal(created.code, 0, created.err);
  assert.equal(created.err, '');
  const task = JSON.parse(created.out);
  const opts = ['--schedule-id', task.scheduleId];
  assert.equal((await call(['list', '--query', 'items[0].name', '--output', 'tsv'])).out.trim(), 'CLI task');
  const updated = await call(['update', ...opts, '--revision', String(task.revision), '--name', 'Edited', '--inherit-model']);
  assert.equal(updated.code, 0, updated.err);
  const fired = await call(['run', ...opts, '--client-token', 'cli-run']);
  assert.equal(fired.code, 0, fired.err);
  const execution = JSON.parse(fired.out);
  assert.equal(execution.state, 'queued');
  const cancelled = await call(['run', 'cancel', ...opts, '--run-id', execution.runId]);
  assert.equal(cancelled.code, 0, cancelled.err);
  assert.equal(JSON.parse(cancelled.out).state, 'cancelled');
  const paused = await call(['pause', ...opts]);
  assert.equal(JSON.parse(paused.out).enabled, false);
  assert.equal((await call(['delete', ...opts])).code, 0);
  assert.equal((await call(['show', ...opts])).code, 3);
  assert.equal((await call(['run', 'list', ...opts])).code, 0, 'deleted schedule keeps execution history');
});

test('restart preserves pending triggers and archive is rechecked after asynchronous edit validation', async (t) => {
  const { user, id, create } = await fixture(t);
  const task = await create();
  closeConnection();
  await initializeDatabase();
  assert.equal(schedulesDb.get(task.scheduleId)!.nextRunAt, task.nextRunAt);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const model = t.mock.method(providerModelsService, 'getProviderModels', async () => {
    await gate;
    return { DEFAULT: 'fixture', OPTIONS: [{ value: 'fixture', label: 'Fixture' }] };
  });
  const editing = schedulesService.update(user, task.scheduleId, { revision: task.revision, model: 'fixture' });
  getConnection().prepare('UPDATE sessions SET isArchived=1 WHERE session_id=?').run(id);
  release();
  await assert.rejects(editing, /changed|archived/);
  model.mock.restore();
  assert.equal(schedulesDb.get(task.scheduleId)!.enabled, false);
  assert.equal(schedulesDb.get(task.scheduleId)!.model, null);
});


test('server timer triggers a one-time task without an open browser and never creates a new session', async (t) => {
  const { create, user } = await fixture(t);
  const now = Date.now();
  const task = await create({ cron: null, runAt: new Date(now + 10000).toISOString() });
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  t.after(closeScheduleDispatcher);
  startScheduleDispatcher();
  assert.equal(schedulesService.runs(user, task.scheduleId, {}).items.length, 0);
  t.mock.timers.tick(10000);
  assert.equal(schedulesService.runs(user, task.scheduleId, {}).items.length, 1);
  t.mock.timers.tick(20000);
  assert.equal(schedulesService.runs(user, task.scheduleId, {}).items.length, 1);
  assert.equal((getConnection().prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count, 1);
  const plan = getConnection().prepare('EXPLAIN QUERY PLAN SELECT * FROM schedules WHERE enabled=1 AND deleted=0 AND next_run_at<=? ORDER BY next_run_at LIMIT 100').all(new Date().toISOString());
  assert.match(JSON.stringify(plan), /schedules_due/);
});

test('history retains ten recent records per schedule, protects unfinished runs and trims them after completion', async (t) => {
  const { user, create } = await fixture(t);
  const task = await create();
  const other = await create({ name: 'Other schedule' });
  const pending = schedulesService.run(user, task.scheduleId, { clientToken: 'retention-retry' });
  const base = Date.parse(pending.createdAt);
  for (let i = 1; i <= 12; i++) {
    const at = new Date(base + i * 1000).toISOString();
    schedulesDb.addRun({
      ...pending, runId: `history-${i}`, state: 'skipped', submissionId: null,
      scheduledFor: at, createdAt: at,
    }, `occurrence-${i}`);
  }
  const second = schedulesService.run(user, other.scheduleId);
  const kept = schedulesDb.runs(task.scheduleId, null, 100);
  assert.equal(kept.length, 11);
  assert.ok(kept.some((run) => run.runId === pending.runId));
  assert.equal(schedulesDb.run('history-1'), null);
  assert.equal(schedulesDb.run('history-2'), null);
  assert.ok(schedulesDb.run('history-3'));
  assert.ok(schedulesDb.run(second.runId));
  schedulesService.change(user, task.scheduleId, 'pause');
  schedulesService.change(user, other.scheduleId, 'pause');
  sessionControlDb.transition(pending.submissionId!, ['queued'], 'succeeded');
  dispatchSchedules();
  assert.equal(schedulesDb.runs(task.scheduleId, null, 100).length, 10);
  assert.equal(schedulesDb.run(pending.runId), null);
  assert.ok(sessionControlDb.get(pending.submissionId!, user), 'retention does not remove conversation submissions');
  assert.deepEqual(schedulesService.run(user, task.scheduleId, { clientToken: 'retention-retry' }), pending);
  assert.ok(schedulesDb.run(second.runId), 'another schedule keeps its own history');
});
