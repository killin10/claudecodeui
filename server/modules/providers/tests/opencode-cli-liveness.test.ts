import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createOpenCodeCliLivenessReader } from '@/modules/providers/services/opencode-cli-liveness.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

async function withService(run: (fixture: {
  root: string;
  file: string;
  active: Record<string, { type: string }>;
  calls: string[];
  state: { pid: number; status: number };
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-liveness-'));
  const file = path.join(root, 'opencode', 'service.json');
  const active: Record<string, { type: string }> = {};
  const calls: string[] = [];
  const state = { pid: process.pid, status: 200 };
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('opencode:fixture-password').toString('base64')}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/info') {
      res.end(JSON.stringify({ version: '2.1.4', pid: state.pid }));
    } else if (req.url === '/api/session/active') {
      res.statusCode = state.status;
      res.end(JSON.stringify({ data: active }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await mkdir(path.dirname(file));
  await writeFile(file, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, pid: process.pid, version: '2.1.4', password: 'fixture-password' }));
  try {
    await run({ root, file, active, calls, state });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

test('external OpenCode observation uses the existing owner, coalesces polls and clears idle/dead owners', async () => {
  await withService(async ({ file, active, calls, state }) => {
    let time = 1000;
    const read = createOpenCodeCliLivenessReader({ file, now: () => time });
    active.ses_external = { type: 'running' };
    const [first, concurrent] = await Promise.all([read(), read()]);
    assert.deepEqual(first, [{ providerSessionId: 'ses_external', startedAt: 1000 }]);
    assert.deepEqual(concurrent, first);
    assert.deepEqual(calls, ['GET /api/info', 'GET /api/session/active']);
    time = 2000;
    assert.deepEqual(await read(), first);
    delete active.ses_external;
    assert.deepEqual(await read(), []);
    active.ses_external = { type: 'running' };
    assert.deepEqual(await read(), [{ providerSessionId: 'ses_external', startedAt: 2000 }]);
    state.pid += 1;
    assert.deepEqual(await read(), [], 'a reused port owned by another PID is not a live registration');
    await rm(file);
    assert.deepEqual(await read(), [], 'a missing registration must not start a service');
  });
});

test('failed external probes never retain stale running indicators', async () => {
  await withService(async ({ file, active, state }) => {
    const read = createOpenCodeCliLivenessReader({ file });
    active.ses_external = { type: 'running' };
    assert.equal((await read()).length, 1);
    state.status = 500;
    assert.deepEqual(await read(), []);
  });
});

test('running sessions map external OpenCode IDs, exclude unknown sessions and prefer app-owned runs', async () => {
  await withService(async ({ root, active }) => {
    const previousState = process.env.XDG_STATE_HOME;
    const previousDatabase = process.env.DATABASE_PATH;
    process.env.XDG_STATE_HOME = root;
    process.env.DATABASE_PATH = path.join(root, 'cloudcli.db');
    closeConnection();
    await initializeDatabase();
    try {
      sessionsDb.createAppSession('app-external', 'opencode', '/fixture');
      sessionsDb.assignProviderSessionId('app-external', 'ses_external');
      active.ses_external = { type: 'running' };
      active.ses_unknown = { type: 'running' };
      const entries = await sessionsService.listRunningSessions();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].sessionId, 'app-external');
      assert.equal(entries[0].canInterrupt, false);
      assert.equal(entries[0].statusText, 'Running in the OpenCode CLI');
      const run = chatRunRegistry.startRun({ appSessionId: 'app-external', provider: 'opencode', providerSessionId: 'ses_external', connection: null, userId: null });
      assert.ok(run);
      try {
        const owned = await sessionsService.listRunningSessions();
        assert.equal(owned.length, 1);
        assert.equal(owned[0].statusText, undefined);
      } finally {
        run.writer.sendComplete({ exitCode: 0 });
      }
    } finally {
      closeConnection();
      if (previousState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousState;
      if (previousDatabase === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousDatabase;
    }
  });
});
