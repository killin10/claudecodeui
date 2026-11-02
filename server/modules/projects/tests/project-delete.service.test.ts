import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { deleteOrArchiveProject } from '@/modules/projects/services/project-delete.service.js';

async function withProject(run: (root: string, projectId: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-delete-'));
  const saved = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    const project = projectsDb.createProjectPath(root).project!;
    sessionsDb.createSession('open-1', 'opencode', root);
    sessionsDb.createSession('open-2', 'opencode', root);
    sessionsDb.updateSessionIsArchived('open-2', true);
    sessionsDb.createSession('unrelated', 'opencode', `${root}/other`);
    await writeFile(path.join(root, 'source.ts'), 'keep');
    await run(root, project.project_id);
  } finally {
    closeConnection();
    if (saved === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = saved;
    await rm(root, { recursive: true, force: true });
  }
}

test('project deletion routes active and archived sessions through provider cleanup', async (t) => {
  await withProject(async (root, projectId) => {
    const calls: string[] = [];
    t.mock.method(sessionsService, 'deleteOrArchiveSessionById', async (id: string, options: unknown) => {
      assert.deepEqual(options, { force: true, deletedFromDisk: true });
      assert.ok(projectsDb.getProjectById(projectId), 'keep project until all native deletions finish');
      calls.push(id);
      sessionsDb.deleteSessionById(id);
      return { sessionId: id, action: 'deleted', deletedFromDisk: true };
    });
    await deleteOrArchiveProject(projectId, true);
    assert.deepEqual(calls.sort(), ['open-1', 'open-2']);
    assert.equal(projectsDb.getProjectById(projectId), null);
    assert.ok(sessionsDb.getSessionById('unrelated'));
    assert.equal(existsSync(path.join(root, 'source.ts')), true);
  });
});

test('failed project cleanup retains the project and undeleted sessions for retry', async (t) => {
  await withProject(async (_root, projectId) => {
    t.mock.method(sessionsService, 'deleteOrArchiveSessionById', async () => {
      throw new Error('OpenCode unavailable');
    });
    await assert.rejects(deleteOrArchiveProject(projectId, true), /OpenCode unavailable/);
    assert.ok(projectsDb.getProjectById(projectId));
    assert.ok(sessionsDb.getSessionById('open-1'));
    assert.ok(sessionsDb.getSessionById('open-2'));
  });
});

test('project archive never invokes permanent session deletion', async (t) => {
  await withProject(async (_root, projectId) => {
    t.mock.method(sessionsService, 'deleteOrArchiveSessionById', async () => {
      assert.fail('archive must preserve native data');
    });
    await deleteOrArchiveProject(projectId, false);
    assert.equal(projectsDb.getProjectById(projectId)?.isArchived, 1);
    assert.ok(sessionsDb.getSessionById('open-1'));
  });
});
