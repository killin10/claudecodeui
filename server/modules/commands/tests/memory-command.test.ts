import assert from 'node:assert/strict';
import test from 'node:test';

import { readMemoryCommand } from '../services/memory-command.service.js';

test('memory selects AGENTS.md for OpenCode and preserves Claude behavior', async () => {
  const paths: unknown[] = [];
  const access = async (filename: unknown) => { paths.push(filename); };
  assert.equal((await readMemoryCommand('/project', 'opencode', access)).path, '/project/AGENTS.md');
  assert.equal((await readMemoryCommand('/project', 'claude', access)).path, '/project/CLAUDE.md');
  assert.deepEqual(paths, ['/project/AGENTS.md', '/project/CLAUDE.md']);
});

test('memory reports missing project/files without masking access failures', async () => {
  const missing = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  const noProject = await readMemoryCommand(undefined, 'opencode', missing);
  assert.match(noProject.message, /AGENTS.md/);
  assert.equal((await readMemoryCommand('/project', 'opencode', missing)).exists, false);
  await assert.rejects(readMemoryCommand('/project', 'opencode', async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  }), /denied/);
});

test('Codex memory opens AGENTS.md', async () => {
  const result = await readMemoryCommand('/project', 'codex', async () => {});
  assert.equal(result.path, '/project/AGENTS.md');
});
