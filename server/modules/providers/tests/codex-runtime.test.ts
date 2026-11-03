import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

function fixture(t: TestContext, script?: (rpc: ReturnType<typeof fakeConnection>) => void, resumed = false) {
  const rpc = fakeConnection(script);
  t.mock.method(codexAppServer, 'connect', async () => rpc as any);
  const messages: AnyRecord[] = [];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => resumed ? 'native-thread' : null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: (raw, sessionId) => new CodexSessionsProvider().normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  return { rpc, messages, context, run: (options: AnyRecord = {}, text = 'hello') => codexRuntime.run(text, { sessionId: 'app-session', cwd: process.cwd(), ...options }, { send: message => messages.push(message as AnyRecord) }, context) };
}

function fakeConnection(script?: (rpc: ReturnType<typeof fakeConnection>) => void) {
  let listener: (message: AnyRecord) => void = () => {};
  let closed: (error: Error) => void = () => {};
  const calls: Array<{ method: string; params: AnyRecord }> = [];
  const replies: Array<{ id: unknown; result: AnyRecord }> = [];
  const rpc = {
    calls, replies, closed: false, terminals: [] as AnyRecord[],
    onMessage(fn: typeof listener) { listener = fn; },
    onClose(fn: typeof closed) { closed = fn; },
    emit(method: string, params: AnyRecord, id?: string | number) { listener({ method, params, id }); },
    complete() { rpc.emit('turn/completed', { threadId: 'native-thread', turn: { id: 'turn', status: 'completed' } }); },
    async call(method: string, params: AnyRecord) {
      calls.push({ method, params });
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'native-thread' } };
      if (method === 'thread/backgroundTerminals/list') return { data: rpc.terminals, nextCursor: null };
      if (method === 'thread/backgroundTerminals/terminate') { rpc.terminals = []; return { terminated: true }; }
      if (method === 'turn/start') {
        rpc.emit('turn/started', { threadId: 'native-thread', turn: { id: 'turn' } });
        if (script) script(rpc); else rpc.complete();
      }
      return {};
    },
    respond(id: unknown, result: AnyRecord) { replies.push({ id, result }); },
    rejectRequest(id: unknown, message: string) { replies.push({ id, result: { error: message } }); },
    async dispose() { rpc.close(); },
    close() { rpc.closed = true; closed(new Error('closed')); },
  };
  return rpc;
}

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'auto', 'unknown', 'acceptEdits', 'bypassPermissions', 'plan']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with native permissions ${permissionMode}`, async t => {
      const { run, rpc, messages } = fixture(t, undefined, resumed);
      await run({ permissionMode });
      const start = rpc.calls[0];
      assert.equal(start.method, resumed ? 'thread/resume' : 'thread/start');
      assert.equal(start.params.sandbox, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(start.params.approvalPolicy, permissionMode === 'bypassPermissions' ? 'never' : 'on-request');
      assert.equal(start.params.approvalsReviewer, permissionMode === 'auto' ? 'auto_review' : 'user');
      const turn = rpc.calls[1].params;
      assert.equal(turn.approvalPolicy, start.params.approvalPolicy);
      assert.equal(turn.approvalsReviewer, start.params.approvalsReviewer);
      assert.equal(turn.sandboxPolicy.type, permissionMode === 'bypassPermissions' ? 'dangerFullAccess' : 'workspaceWrite');
      assert.equal(rpc.calls[1].params.collaborationMode.mode, permissionMode === 'plan' ? 'plan' : 'default');
      assert.ok(messages.some(message => message.kind === 'complete' && message.exitCode === 0));
      assert.equal(rpc.closed, true);
    });
  }
}

for (const text of ['', '  \n\t']) {
  test(`Codex image-only turn ${JSON.stringify(text)}`, async t => {
    const { run, rpc } = fixture(t);
    const imagePath = path.join(process.cwd(), 'public', 'favicon.png');
    await run({ images: [{ path: imagePath, mimeType: 'image/png' }] }, text);
    assert.deepEqual(rpc.calls[1].params.input, [
      { type: 'text', text: 'Please analyze the attached image(s).', text_elements: [] },
      { type: 'localImage', path: imagePath },
    ]);
  });
}

test('Codex approvals survive reconnect, return the decision, and disappear', async t => {
  const { run, rpc, messages } = fixture(t, rpc => rpc.emit('item/commandExecution/requestApproval', { threadId: 'native-thread', command: 'touch /outside/test' }, 10));
  const running = run();
  await new Promise(resolve => setImmediate(resolve));
  const request = messages.find(message => message.kind === 'permission_request')!;
  assert.equal(codexRuntime.permissions.listPending('app-session').length, 1);
  codexRuntime.permissions.resolve(request.requestId, { allow: false });
  assert.deepEqual(rpc.replies[0], { id: 10, result: { decision: 'decline' } });
  assert.equal(codexRuntime.permissions.listPending('app-session').length, 0);
  rpc.complete();
  await running;
});

test('acceptEdits approves edits but still asks about commands; bypass still asks questions', async t => {
  const { run, rpc, messages } = fixture(t, rpc => {
    rpc.emit('item/fileChange/requestApproval', { threadId: 'native-thread' }, 1);
    rpc.emit('item/commandExecution/requestApproval', { threadId: 'native-thread', command: 'deploy' }, 2);
    rpc.complete();
  });
  await run({ permissionMode: 'acceptEdits' });
  assert.deepEqual(rpc.replies[0], { id: 1, result: { decision: 'accept' } });
  assert.ok(messages.some(message => message.kind === 'permission_request' && message.toolName === 'Bash'));
});

test('Codex questions translate answer lists to stable native question ids', async t => {
  const { run, rpc, messages } = fixture(t, rpc => rpc.emit('item/tool/requestUserInput', {
    threadId: 'native-thread', questions: [{ id: 'color', question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: '' }] }],
  }, 'question-id'));
  const running = run({ permissionMode: 'bypassPermissions' });
  await new Promise(resolve => setImmediate(resolve));
  const request = messages.find(message => message.kind === 'permission_request')!;
  assert.equal(request.toolName, 'AskUserQuestion');
  codexRuntime.permissions.resolve(request.requestId, { allow: true, updatedInput: { answers: [['Red']] } });
  assert.deepEqual(rpc.replies[0].result, { answers: { color: { answers: ['Red'] } } });
  rpc.complete();
  await running;
});

test('abort closes the native process and retracts approvals without reporting success', async t => {
  const { run, rpc, messages } = fixture(t, rpc => rpc.emit('item/commandExecution/requestApproval', { threadId: 'native-thread' }, 3));
  const running = run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await codexRuntime.abort('app-session'), true);
  await running;
  assert.equal(rpc.closed, true);
  assert.equal(codexRuntime.permissions.listPending('app-session').length, 0);
  assert.ok(messages.some(message => message.kind === 'permission_cancelled'));
  assert.ok(!messages.some(message => message.kind === 'complete' && message.exitCode === 0));
});

test('native text deltas reuse one id and context usage uses last rather than cumulative tokens', async t => {
  const { run, messages } = fixture(t, rpc => {
    rpc.emit('item/started', { threadId: 'native-thread', item: { type: 'agentMessage', id: 'answer', text: '' } });
    rpc.emit('item/agentMessage/delta', { threadId: 'native-thread', itemId: 'answer', delta: 'Hello' });
    rpc.emit('item/agentMessage/delta', { threadId: 'native-thread', itemId: 'answer', delta: ' world' });
    rpc.emit('thread/tokenUsage/updated', { threadId: 'native-thread', tokenUsage: { total: { totalTokens: 810000 }, last: { inputTokens: 30000, outputTokens: 1000, totalTokens: 31000 }, modelContextWindow: 1000000 } });
    rpc.complete();
  });
  await run();
  assert.equal(messages.filter(message => message.kind === 'text').at(-1)?.content, 'Hello world');
  assert.equal(new Set(messages.filter(message => message.kind === 'text').map(message => message.id)).size, 1);
  assert.equal(messages.find(message => message.tokenBudget)?.tokenBudget.used, 31000);
});

test('background agent keeps parent alive and can be stopped independently', async t => {
  const { run, rpc } = fixture(t, rpc => {
    rpc.emit('item/completed', { threadId: 'native-thread', item: { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } } });
    rpc.emit('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
    rpc.complete();
  });
  const running = run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rpc.closed, false);
  assert.equal(codexRuntime.listBackgroundWork()[0].tasks[0].taskId, 'child');
  assert.equal(await codexRuntime.stopBackgroundTask('app-session', 'child'), true);
  assert.ok(rpc.calls.some(call => call.method === 'turn/interrupt' && call.params.threadId === 'child'));
  assert.equal(codexRuntime.listBackgroundWork().length, 0);
  await codexRuntime.abort('app-session');
  await running;
});

test('native Plan uses the shared Build decision to start an implementation turn', async t => {
  let turns = 0;
  const { run, rpc, messages } = fixture(t, rpc => {
    if (turns++ === 0) rpc.emit('item/completed', { threadId: 'native-thread', item: { type: 'plan', id: 'plan', text: 'Change the test file.' } });
    rpc.complete();
  });
  const running = run({ permissionMode: 'plan' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rpc.closed, false);
  const request = messages.find(message => message.kind === 'permission_request' && message.toolName === 'ExitPlanMode')!;
  assert.ok(request);
  codexRuntime.permissions.resolve(request.requestId, { allow: true });
  await running;
  const starts = rpc.calls.filter(call => call.method === 'turn/start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].params.collaborationMode.mode, 'default');
  assert.equal(starts[1].params.input[0].text, 'Implement the plan.');
});

test('a new user turn reuses the owned server while a child is still running', async t => {
  let turns = 0;
  const { run, rpc, messages, context } = fixture(t, rpc => {
    if (turns++ === 0) rpc.emit('item/completed', { threadId: 'native-thread', item: { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } } });
    rpc.complete();
  });
  const first = run();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(messages.some(message => message.kind === 'complete'));
  assert.equal(rpc.closed, false);
  context.resolveProviderSessionId = () => 'native-thread';
  const nextMessages: AnyRecord[] = [];
  const next = codexRuntime.run('Follow up', { sessionId: 'app-session', permissionMode: 'bypassPermissions' }, { send: message => nextMessages.push(message as AnyRecord) }, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rpc.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start')[1].params.approvalPolicy, 'never');
  assert.deepEqual(rpc.calls.filter(call => call.method === 'turn/start')[1].params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.ok(nextMessages.some(message => message.kind === 'complete'));
  assert.equal(codexRuntime.listBackgroundWork()[0].tasks.length, 1);
  const restricted = codexRuntime.run('Use the sandbox again', { sessionId: 'app-session', permissionMode: 'default' }, { send: () => {} }, context);
  await new Promise(resolve => setImmediate(resolve));
  const restrictedTurn = rpc.calls.filter(call => call.method === 'turn/start')[2].params;
  assert.equal(restrictedTurn.approvalPolicy, 'on-request');
  assert.equal(restrictedTurn.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(restrictedTurn.sandboxPolicy.networkAccess, false);
  await codexRuntime.abort('app-session');
  await Promise.all([first, next, restricted]);
});

test('native background commands stay visible after the reply and stop through their native process id', async t => {
  const { run, rpc, messages } = fixture(t, rpc => {
    rpc.terminals = [{ processId: 'process-1', itemId: 'command-1', command: 'sleep 100' }];
    rpc.complete();
  });
  const running = run();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(messages.some(message => message.kind === 'complete'));
  const task = codexRuntime.listBackgroundWork()[0].tasks[0];
  assert.equal(task.taskType, 'command');
  assert.equal(await codexRuntime.stopBackgroundTask('app-session', task.taskId), true);
  assert.ok(rpc.calls.some(call => call.method === 'thread/backgroundTerminals/terminate' && call.params.processId === 'process-1'));
  assert.equal(codexRuntime.listBackgroundWork().length, 0);
  await codexRuntime.abort('app-session');
  await running;
});

test('a settled child releases the server even while reconciliation continues polling', { timeout: 15000 }, async t => {
  const { run, rpc } = fixture(t, rpc => {
    rpc.emit('item/completed', { threadId: 'native-thread', item: { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } } });
    rpc.complete();
  });
  const running = run();
  await new Promise(resolve => setImmediate(resolve));
  rpc.emit('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } });
  await running;
  assert.equal(rpc.closed, true);
  assert.equal(codexRuntime.listBackgroundWork().length, 0);
});


test('remembering a Codex approval uses its native session-scoped decision', async t => {
  const { run, rpc, messages } = fixture(t, rpc => rpc.emit('item/commandExecution/requestApproval', { threadId: 'native-thread', command: 'npm test', availableDecisions: ['accept', 'acceptForSession', 'decline'] }, 42));
  const running = run();
  await new Promise(resolve => setImmediate(resolve));
  const request = messages.find(message => message.kind === 'permission_request')!;
  assert.equal(request.context.approvalPersistence, 'session');
  codexRuntime.permissions.resolve(request.requestId, { allow: true, rememberEntry: 'session' });
  assert.deepEqual(rpc.replies[0], { id: 42, result: { decision: 'acceptForSession' } });
  rpc.complete();
  await running;
});


test('persistent Codex command approval uses only the prefix proposed by the native server', async t => {
  const { run, rpc, messages } = fixture(t, rpc => rpc.emit('item/commandExecution/requestApproval', {
    threadId: 'native-thread', command: 'git status', proposedExecpolicyAmendment: ['git', 'status'],
  }, 43));
  const running = run();
  await new Promise(resolve => setImmediate(resolve));
  const request = messages.find(message => message.kind === 'permission_request')!;
  assert.deepEqual(request.context.always, ['["git","status"]']);
  codexRuntime.permissions.resolve(request.requestId, { allow: true, rememberEntry: 'always', updatedInput: { command: 'rm' } });
  assert.deepEqual(rpc.replies[0].result, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } } });
  rpc.complete();
  await running;
});
