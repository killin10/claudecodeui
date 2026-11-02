import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

async function withStore(run: (fixture: {
  root: string;
  native: Database.Database;
  synchronizer: OpenCodeSessionSynchronizer;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-delete-'));
  const saved = { DATABASE_PATH: process.env.DATABASE_PATH, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  process.env.XDG_DATA_HOME = root;
  closeConnection();
  await initializeDatabase();
  await mkdir(path.join(root, 'opencode'));
  const native = new Database(path.join(root, 'opencode', 'opencode.db'));
  native.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT,
      title TEXT, metadata TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER
    );
  `);
  native.prepare('INSERT INTO session_v2 (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)')
    .run('ses_delete', root, 'Delete me', 1700000000000, 1700000000000);
  sessionsDb.createAppSession('app-delete', 'opencode', root);
  sessionsDb.assignProviderSessionId('app-delete', 'ses_delete');
  const adapter = providerRegistry.resolveProvider('opencode').sessions;
  const original = adapter.deleteSessionData;
  try {
    await run({ root, native, synchronizer: new OpenCodeSessionSynchronizer() });
  } finally {
    adapter.deleteSessionData = original;
    native.close();
    closeConnection();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('native deletion keeps the mapped index until success and scans cannot resurrect it', async () => {
  await withStore(async ({ native, synchronizer }) => {
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const release = new Promise<void>((resolve) => { finish = resolve; });
    providerRegistry.resolveProvider('opencode').sessions.deleteSessionData = async (id) => {
      assert.equal(id, 'ses_delete', 'use the provider id, not the app id');
      entered();
      await release;
      native.prepare('DELETE FROM session_v2 WHERE id = ?').run(id);
      return true;
    };
    const deletion = sessionsService.deleteOrArchiveSessionById('app-delete', { force: true, deletedFromDisk: true });
    await started;
    await synchronizer.synchronizeFile('opencode.db-wal');
    assert.ok(sessionsDb.getSessionById('app-delete'), 'retain the index while native deletion is pending');
    finish();
    assert.equal((await deletion).deletedFromDisk, true);
    await synchronizer.synchronizeFile('opencode.db-wal');
    await new OpenCodeSessionSynchronizer().synchronize();
    assert.equal(sessionsDb.getSessionById('app-delete'), null);
    assert.equal(sessionsDb.getSessionByProviderSessionId('ses_delete'), null);
  });
});

test('native deletion failure preserves the index and is retryable', async () => {
  await withStore(async ({ native }) => {
    const adapter = providerRegistry.resolveProvider('opencode').sessions;
    adapter.deleteSessionData = async () => { throw new Error('native delete failed'); };
    await assert.rejects(
      sessionsService.deleteOrArchiveSessionById('app-delete', { force: true, deletedFromDisk: true }),
      /native delete failed/,
    );
    assert.ok(sessionsDb.getSessionById('app-delete'));
    assert.deepEqual(native.prepare('SELECT count(*) AS n FROM session_v2').get(), { n: 1 });
    native.prepare('DELETE FROM session_v2 WHERE id = ?').run('ses_delete');
    adapter.deleteSessionData = async () => false;
    const result = await sessionsService.deleteOrArchiveSessionById('app-delete', { force: true, deletedFromDisk: true });
    assert.equal(result.deletedFromDisk, false, 'an already absent native session allows index cleanup');
    assert.equal(sessionsDb.getSessionById('app-delete'), null);
  });
});

test('archive and draft deletion do not delete native data', async () => {
  await withStore(async ({ root, native }) => {
    providerRegistry.resolveProvider('opencode').sessions.deleteSessionData = async () => {
      assert.fail('must not delete native data');
    };
    await sessionsService.deleteOrArchiveSessionById('app-delete');
    assert.equal(sessionsDb.getSessionById('app-delete')?.isArchived, 1);
    sessionsDb.createAppSession('draft', 'opencode', root);
    await sessionsService.deleteOrArchiveSessionById('draft', { force: true, deletedFromDisk: true });
    assert.equal(sessionsDb.getSessionById('draft'), null);
    assert.deepEqual(native.prepare('SELECT count(*) AS n FROM session_v2').get(), { n: 1 });
  });
});

test('permanent deletion refuses a running session before invoking the provider', async (t) => {
  await withStore(async () => {
    t.mock.method(chatRunRegistry, 'isProcessing', () => true);
    providerRegistry.resolveProvider('opencode').sessions.deleteSessionData = async () => {
      assert.fail('must not delete an active run');
    };
    await assert.rejects(
      sessionsService.deleteOrArchiveSessionById('app-delete', { force: true, deletedFromDisk: true }),
      { code: 'SESSION_BUSY' },
    );
    assert.ok(sessionsDb.getSessionById('app-delete'));
  });
});

test('file-backed deletion still removes Codex transcripts and keeps project files', async () => {
  await withStore(async ({ root }) => {
    const transcript = path.join(root, 'rollout.jsonl');
    const source = path.join(root, 'source.ts');
    await writeFile(transcript, '{}');
    await writeFile(source, 'keep');
    sessionsDb.createSession('codex-delete', 'codex', root, 'Codex', undefined, undefined, transcript);
    const result = await sessionsService.deleteOrArchiveSessionById('codex-delete', { force: true, deletedFromDisk: true });
    assert.equal(result.deletedFromDisk, true);
    assert.equal(existsSync(transcript), false);
    assert.equal(existsSync(source), true);
    assert.ok(projectsDb.getProjectPath(root));
  });
});
