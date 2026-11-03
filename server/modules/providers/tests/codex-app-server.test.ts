import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';

test('installed Codex accepts initialization, native skill discovery, thread start and Plan modes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-native-contract-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(directory, 'codex');
  await mkdir(process.env.CODEX_HOME, { recursive: true });
  let connection;
  try {
    const skill = path.join(directory, '.agents', 'skills', 'native-contract');
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, 'SKILL.md'), '---\nname: native-contract\ndescription: Isolated protocol contract fixture.\n---\n');
    connection = await codexAppServer.connect();
    const skills = await connection.call('skills/list', { cwds: [directory], forceReload: true });
    assert.ok(skills.data[0].skills.some((entry: any) => entry.name === 'native-contract'));
    const started = await connection.call('thread/start', { cwd: directory, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    assert.equal(typeof started.thread.id, 'string');
    const modes = await connection.call('collaborationMode/list', {});
    assert.ok(modes.data.some((mode: any) => mode.mode === 'plan'));
  } finally {
    await connection?.dispose();
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
