import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { codexAppServer, type CodexRpcConnection } from '@/modules/providers/list/codex/codex-app-server.client.js';

/** Actual bundled CLI against a local Responses fixture: no external API or credentials. */
test('native Codex runs, resumes and forks a persisted thread through app-server', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-native-turn-'));
  const previous = process.env.CODEX_HOME;
  const home = path.join(directory, 'codex');
  await mkdir(home);
  let sequence = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      sequence++;
      const item = { id: `msg-${sequence}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture response.', annotations: [] }], status: 'completed' };
      const events = [
        { type: 'response.created', response: { id: `resp-${sequence}`, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Fixture response.' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `resp-${sequence}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } } } },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  let connection: CodexRpcConnection | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as { port: number };
    await writeFile(path.join(home, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
    process.env.CODEX_HOME = home;
    connection = await codexAppServer.connect();
    const started = await connection.call('thread/start', { cwd: directory, approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' });
    const threadId = started.thread.id;
    const turn = async () => {
      let finish!: (value: any) => void;
      const completed = new Promise<any>(resolve => { finish = resolve; });
      const remove = connection!.onMessage(message => {
        const params = message.params;
        if (message.method === 'turn/completed' && params && params.threadId === threadId) finish(params.turn);
      });
      const timeout = setTimeout(() => connection!.close(new Error('Fixture turn timed out')), 15000);
      const onClose = connection!.onClose(error => finish({ status: 'failed', error }));
      try {
        await connection!.call('turn/start', { threadId, input: [{ type: 'text', text: 'Reply briefly.', text_elements: [] }] });
        const result = await completed;
        assert.equal(result.status, 'completed', JSON.stringify(result.error));
        return result.id;
      } finally { clearTimeout(timeout); remove(); onClose(); }
    };
    const turnId = await turn();
    const terminals = await connection.call('thread/backgroundTerminals/list', { threadId, limit: 100 });
    assert.deepEqual(terminals.data, []);
    await connection.dispose();
    connection = await codexAppServer.connect();
    const resumed = await connection.call('thread/resume', { threadId, excludeTurns: true });
    assert.equal(resumed.thread.id, threadId);
    await turn();
    const fork = await codexAppServer.forkThread({ threadId, lastTurnId: turnId, cwd: directory });
    assert.notEqual(fork.threadId, threadId);
    assert.ok((await realpath(fork.path)).startsWith(await realpath(home)));
    assert.equal(sequence, 2);
  } finally {
    await connection?.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
