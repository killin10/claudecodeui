import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { startOpenCodeServer } from '@/modules/providers/list/opencode/opencode-server.provider.js';
import { createOpenCodeSettingsPermissionsService } from '@/modules/providers/services/opencode-settings-permissions.service.js';

test('permission settings filter secrets, preserve JSONC and reject stale/invalid writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-permission-settings-'));
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = path.join(root, 'opencode');
  await mkdir(path.join(root, 'opencode'));
  const filename = path.join(root, 'opencode/opencode.jsonc');
  const initial = '// keep this comment\n{ "mcp": { "servers": {} }, "permissions": [{ "action": "shell", "resource": "git *", "effect": "ask" }], }\n';
  await writeFile(filename, initial);
  let closed = 0;
  const scopes: unknown[] = [];
  const service = createOpenCodeSettingsPermissionsService(async () => ({
    server: { close: () => { closed++; } },
    client: {
      config: { get: async (input: unknown) => {
        scopes.push(input);
        return [{ type: 'document', path: '/project/opencode.json', info: {
          permissions: [{ action: 'edit', resource: '*', effect: 'deny' }],
          providers: { test: { apiKey: 'DO_NOT_EXPOSE' } },
          agents: { plan: { permissions: [{ action: 'shell', resource: '*', effect: 'ask' }], prompt: 'DO_NOT_EXPOSE' } },
        } }];
      } },
      location: { get: async () => ({ project: { id: 'prj_test' } }) },
      permission: { saved: { list: async (input: unknown) => {
        assert.deepEqual(input, { projectID: 'prj_test' });
        return [{ id: 'saved_1', action: 'shell', resource: 'pwd' }];
      } } },
    },
  } as unknown as Awaited<ReturnType<typeof startOpenCodeServer>>));
  try {
    const settings = await service.read('/project');
    assert.equal(closed, 1);
    assert.deepEqual(scopes, [{ location: { directory: '/project' } }]);
    assert.ok(!JSON.stringify(settings).includes('DO_NOT_EXPOSE'));
    assert.equal(settings.sources[0].agents[0].name, 'plan');
    assert.equal(settings.saved[0].resource, 'pwd');
    const rules = [{ action: 'shell', resource: 'git status *', effect: 'allow' }];
    await service.save({ revision: settings.editable.revision, rules });
    const updated = await readFile(filename, 'utf8');
    assert.ok(updated.startsWith('// keep this comment'));
    assert.ok(updated.includes('"mcp": { "servers": {} }'));
    assert.ok(updated.includes('git status *'));
    await assert.rejects(service.save({ revision: settings.editable.revision, rules }), /changed/);
    await assert.rejects(service.save({ rules: [{ action: '*', resource: '*', effect: 'unknown' }] }), /allow\/deny\/ask/);
    assert.equal(await readFile(filename, 'utf8'), updated);
    await writeFile(filename, '{ invalid');
    await assert.rejects(service.read('/project'), /invalid OpenCode/);
    assert.equal(closed, 1, 'invalid config is rejected before starting a server');
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('saved approvals are scoped to the native project and stale/failed changes do not silently succeed', async () => {
  let closed = 0;
  let rule = { id: 'saved_one', action: 'shell', resource: 'pwd' };
  const changes: unknown[] = [];
  const service = createOpenCodeSettingsPermissionsService(async () => ({
    server: { close: () => { closed++; } },
    client: {
      location: { get: async () => ({ project: { id: 'project_one' } }) },
      permission: { saved: {
        list: async (input: unknown) => { assert.deepEqual(input, { projectID: 'project_one' }); return [rule]; },
        update: async (input: typeof rule) => { changes.push(input); rule = input; },
        remove: async (input: { id: string }) => { changes.push(input); throw new Error('native failure'); },
      } },
    },
  } as unknown as Awaited<ReturnType<typeof startOpenCodeServer>>));
  const input = { id: rule.id, operation: 'update', workspacePath: '/project', expected: { action: 'shell', resource: 'pwd' }, rule: { action: 'shell', resource: 'git status' } };
  await assert.rejects(service.changeSaved({ ...input, id: 'another_project_grant' }), /not found in this project/);
  await service.changeSaved(input);
  assert.deepEqual(rule, { id: 'saved_one', action: 'shell', resource: 'git status' });
  await assert.rejects(service.changeSaved(input), /changed/);
  await assert.rejects(service.changeSaved({ ...input, expected: rule, operation: 'remove' }), /native failure/);
  assert.equal(closed, 4);
  assert.equal(changes.length, 2);
});
