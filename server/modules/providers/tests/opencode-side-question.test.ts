import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { opencodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import type { SideQuestionRequest } from '@/shared/types.js';
import { SIDE_CONVERSATION_BOUNDARY_PROMPT } from '@/shared/utils.js';

// V2 replaces V1's fork/prompt/delete protocol with session.generate. Exercise
// the real V2 client against the fixture and prohibit all session mutations.
async function fixture(t: test.TestContext, scenario: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-side-v2-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const script = fileURLToPath(new URL('./fixtures/fake-opencode-serve.ts', import.meta.url));
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(path.join(bin, 'opencode'), `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(import.meta.resolve('tsx/esm'))} ${quote(script)} "$@"\n`);
  await chmod(path.join(bin, 'opencode'), 0o700);
  const log = path.join(root, 'requests.jsonl');
  const changes = {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_OPENCODE_LOG: log,
    FAKE_OPENCODE_SCENARIO: JSON.stringify({ sessions: { parent: {} }, steps: [], ...scenario }),
  };
  const saved = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  Object.assign(process.env, changes);
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const request: SideQuestionRequest = {
    appSessionId: 'app-parent', providerSessionId: 'parent', projectPath: root,
    question: 'What did the previous step establish?', model: 'unused-selection', signal: new AbortController().signal,
  };
  const deltas: string[] = [];
  const ask = (overrides: Partial<SideQuestionRequest> = {}) => opencodeRuntime.askSideQuestion(
    { ...request, ...overrides }, { delta: text => { deltas.push(text); } },
  );
  const entries = async (): Promise<Array<Record<string, any>>> => {
    const text = await readFile(log, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  return { ask, entries, deltas };
}

test('V2 side question uses native context generation and never mutates or forks the parent', async t => {
  const f = await fixture(t, { generateText: 'Only the new answer' });
  assert.deepEqual(await f.ask(), { status: 'done', answer: 'Only the new answer' });
  assert.deepEqual(f.deltas, ['Only the new answer']);
  const writes = (await f.entries()).filter(entry => entry.method && entry.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/api/session/parent/generate');
  assert.deepEqual(writes[0].body, { prompt: `${SIDE_CONVERSATION_BOUNDARY_PROMPT}\n\nWhat did the previous step establish?` });
  assert.match(writes[0].authorization, /^Basic /);
});

for (const missing of [null, '']) {
  test(`missing provider session (${String(missing)}) fails without starting a server`, async t => {
    const f = await fixture(t);
    const result = await f.ask({ providerSessionId: missing });
    assert.equal(result.status, 'error');
    assert.deepEqual(await f.entries(), []);
  });
}

test('missing native session propagates failure without falling back to a main prompt', async t => {
  const f = await fixture(t);
  assert.equal((await f.ask({ providerSessionId: 'missing' })).status, 'error');
  assert.deepEqual(f.deltas, []);
  assert.ok((await f.entries()).every(entry => !entry.path || !/\/prompt|\/fork|\/interrupt/.test(entry.path)));
});

test('generation failure is an error outcome, never an empty success', async t => {
  const f = await fixture(t, { generateStatus: 500 });
  const result = await f.ask();
  assert.equal(result.status, 'error');
  assert.deepEqual(f.deltas, []);
});

test('an empty native response does not appear as a successful answer', async t => {
  const f = await fixture(t, { generateText: '' });
  assert.equal((await f.ask()).status, 'error');
  assert.deepEqual(f.deltas, []);
});

test('dismiss before startup launches no process', async t => {
  const f = await fixture(t);
  const result = await f.ask({ signal: AbortSignal.abort() });
  assert.equal(result.status, 'error');
  assert.deepEqual(await f.entries(), []);
});

test('dismiss during generation cancels the private request without interrupting the parent', async t => {
  const f = await fixture(t, { generateDelayMs: 5000 });
  const controller = new AbortController();
  const pending = f.ask({ signal: controller.signal });
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await f.entries()).some(entry => entry.path?.endsWith('/generate'))) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok((await f.entries()).some(entry => entry.path?.endsWith('/generate')));
  controller.abort();
  assert.deepEqual(await pending, { status: 'error', error: 'The side question was dismissed.', answer: '' });
  assert.deepEqual(f.deltas, []);
  assert.ok((await f.entries()).every(entry => !entry.path?.endsWith('/interrupt')));
});
