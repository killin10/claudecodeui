import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ProviderPermissionDecision, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * Drives the OpenCode runtime and the real `@opencode/client` against a fake
 * `opencode serve` (tests/fixtures/fake-opencode-serve.ts) found on PATH, so
 * every turn goes through the SDK's own server start, client calls and event
 * stream without a real OpenCode or model.
 */

// Read when the runtime module loads, so set before importing it — the
// sessions provider imports the runtime too, so it is loaded dynamically as well.
process.env.OPENCODE_TOOL_APPROVAL_TIMEOUT_MS = '1500';
const {
  isCoveredByApprovals,
  opencodeRuntime,
  readQuestionAnswers,
  reapOrphanedOpenCodeServers,
  resolveAutomaticPermissionReply,
  toOpenCodePermissionReply,
} = await import('@/modules/providers/list/opencode/opencode-runtime.provider.js');
const { OpenCodeSessionsProvider } = await import('@/modules/providers/list/opencode/opencode-sessions.provider.js');

type Frame = Record<string, any>;
type LogEntry = Record<string, any>;

const TURN_DEADLINE_MS = 30_000;

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fake-opencode-serve.ts', import.meta.url));
const TSX_LOADER = import.meta.resolve('tsx/esm');
const sessionsProvider = new OpenCodeSessionsProvider();

let tempRoot = '';
let binDir = '';
let projectDir = '';
let logCounter = 0;
const savedEnv: Record<string, string | undefined> = {};

const findEnvKey = (name: string) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

const setEnv = (name: string, value: string | undefined) => {
  if (!(name in savedEnv)) {
    savedEnv[name] = process.env[name];
  }
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-sdk-runtime-'));
  binDir = path.join(tempRoot, 'bin');
  projectDir = path.join(tempRoot, 'project');
  await Promise.all([mkdir(binDir), mkdir(projectDir)]);

  // `opencode` on PATH runs the fixture through tsx, as the real CLI would run.
  if (process.platform === 'win32') {
    await writeFile(
      path.join(binDir, 'opencode.cmd'),
      `@echo off\r\n"${process.execPath}" --import "${TSX_LOADER}" "${FIXTURE_PATH}" %*\r\n`,
    );
    const pathExtKey = findEnvKey('PATHEXT');
    const pathExt = process.env[pathExtKey];
    setEnv(pathExtKey, pathExt?.toUpperCase().includes('.CMD') ? pathExt : `.COM;.EXE;.BAT;.CMD${pathExt ? `;${pathExt}` : ''}`);
  } else {
    const wrapper = path.join(binDir, 'opencode');
    await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" --import "${TSX_LOADER}" "${FIXTURE_PATH}" "$@"\n`);
    await chmod(wrapper, 0o755);
  }

  const pathKey = findEnvKey('PATH');
  setEnv(pathKey, `${binDir}${path.delimiter}${process.env[pathKey] || ''}`);
  // Token usage is read from ~/.local/share/opencode; keep the real one out of it.
  setEnv('HOME', tempRoot);
  setEnv('USERPROFILE', tempRoot);
  setEnv('OPENCODE_SERVER_PASSWORD', undefined);
});

after(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  await rm(tempRoot, { recursive: true, force: true });
});

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitForExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

type TurnOptions = {
  scenario: Record<string, unknown>;
  appSessionId?: string;
  resumeSessionId?: string | null;
  command?: string;
  permissionMode?: string;
  files?: unknown[];
  installed?: boolean;
  normalizeMessage?: ProviderRuntimeContext['normalizeMessage'];
  /** Called for every frame the chat receives; return a decision to answer a permission_request. */
  onFrame?: (frame: Frame) => ProviderPermissionDecision | void;
};

async function runTurn(options: TurnOptions) {
  const logPath = path.join(tempRoot, `requests-${++logCounter}.jsonl`);
  setEnv('FAKE_OPENCODE_SCENARIO', JSON.stringify(options.scenario));
  setEnv('FAKE_OPENCODE_LOG', logPath);

  const frames: Frame[] = [];
  const writer = {
    userId: null,
    sessionId: null as string | null,
    send(message: unknown) {
      const frame = message as Frame;
      frames.push(frame);
      const decision = options.onFrame?.(frame);
      if (decision && frame.kind === 'permission_request') {
        setImmediate(() => opencodeRuntime.permissions.resolve(frame.requestId, decision));
      }
    },
    setSessionId(sessionId: string) {
      this.sessionId = sessionId;
    },
  };
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => options.resumeSessionId ?? null,
    resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
    normalizeMessage: options.normalizeMessage ?? ((raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId)),
    isProviderInstalled: async () => options.installed ?? true,
  };

  const appSessionId = options.appSessionId ?? 'app-session';
  const running = opencodeRuntime.run(options.command ?? 'Hi', {
    sessionId: appSessionId,
    cwd: projectDir,
    model: 'github-copilot/gpt-5.6-terra',
    permissionMode: options.permissionMode,
    files: options.files,
  }, writer, context).then(() => null, (caught: unknown) => caught as Error);
  // A turn that never ends fails its test instead of hanging the whole file.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    running,
    new Promise<'timeout'>((resolve) => {
      deadline = setTimeout(() => resolve('timeout'), TURN_DEADLINE_MS);
    }),
  ]);
  clearTimeout(deadline);
  if (outcome === 'timeout') {
    await Promise.race([opencodeRuntime.abort(appSessionId), new Promise((resolve) => setTimeout(resolve, 5000))]);
    throw new Error(`The turn did not finish within ${TURN_DEADLINE_MS / 1000} s.`);
  }
  const error = outcome;

  let requests: LogEntry[] = [];
  try {
    requests = (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    // No server ever started.
  }
  const started = requests.find((entry) => entry.started);
  return {
    frames,
    error,
    writer,
    requests: requests.filter((entry) => !entry.started),
    serverPid: started?.pid as number | undefined,
    started,
  };
}

const kinds = (frames: Frame[]) => frames.map((frame) => frame.kind);
const findRequest = (requests: LogEntry[], method: string, pathPattern: RegExp) =>
  requests.find((entry) => entry.method === method && pathPattern.test(entry.path));

const permissionStep = (patterns: string[], always: string[], permission = 'shell', id = 'per_1') => ({
  type: 'permission',
  id,
  permission,
  patterns,
  always,
  metadata: { command: patterns[0] },
});

const questionStep = {
  type: 'question',
  id: 'que_1',
  questions: [
    { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] },
    {
      question: 'Which sizes?',
      header: 'Sizes',
      multiple: true,
      options: [{ label: 'Small', description: '' }, { label: 'Large, wide', description: '' }],
    },
  ],
};

test('requests from an existing nested child are routed without a session.created event', async () => {
  const turn = await runTurn({
    resumeSessionId: 'ses_parent',
    scenario: {
      sessions: { ses_parent: {}, ses_child: { parentID: 'ses_parent' }, ses_grandchild: { parentID: 'ses_child' } },
      steps: [
        { ...permissionStep(['pwd'], []), sessionID: 'ses_grandchild' },
        { ...questionStep, sessionID: 'ses_child' },
      ],
    },
    onFrame: (frame) => frame.kind === 'permission_request'
      ? { allow: true, updatedInput: { answers: [['Red'], ['Small']] } }
      : undefined,
  });
  assert.equal(turn.error, null);
  assert.equal(turn.frames.filter((frame) => frame.kind === 'permission_request').length, 2);
  assert.ok(findRequest(turn.requests, 'POST', /\/session\/ses_grandchild\/permission\/per_1\/reply$/));
  assert.ok(findRequest(turn.requests, 'POST', /\/session\/ses_child\/form\/que_1\/reply$/));
});

test('foreign sessions and global forms from another directory are not offered to this chat', async () => {
  const turn = await runTurn({
    resumeSessionId: 'ses_parent',
    scenario: {
      sessions: { ses_parent: {}, ses_foreign: {} },
      events: [
        { type: 'permission.asked', data: { ...permissionStep(['pwd'], []), sessionID: 'ses_foreign' } },
        { type: 'form.created', location: { directory: '/unrelated' }, data: {
          form: { id: 'frm_foreign', sessionID: 'global', title: 'Foreign', metadata: { kind: 'mcp-elicitation' }, fields: [] },
        } },
      ],
      steps: [],
    },
  });
  assert.equal(turn.error, null);
  assert.equal(turn.frames.some((frame) => frame.kind === 'permission_request'), false);
});

test('MCP global forms retain their location, question text and external acknowledgement', async () => {
  const turn = await runTurn({
    scenario: { steps: [{ type: 'form', directory: projectDir, form: {
      id: 'frm_mcp', sessionID: 'global', title: 'MCP input', metadata: { kind: 'mcp-elicitation' },
      fields: [
        { key: 'scope', type: 'string', title: 'Scope', description: 'Review staged changes or the whole repository?',
          options: [{ label: 'Staged', value: 'staged' }] },
        { key: 'auth', type: 'external', title: 'Sign in', url: 'https://example.com/auth' },
      ],
    } }] },
    onFrame: (frame) => frame.kind === 'permission_request'
      ? { allow: true, updatedInput: { answers: [['Staged'], ['Continue']] } }
      : undefined,
  });
  assert.equal(turn.error, null);
  const request = turn.frames.find((frame) => frame.kind === 'permission_request');
  assert.equal(request?.input.questions[0].question, 'Review staged changes or the whole repository?');
  assert.equal(request?.input.questions[0].header, 'Scope');
  assert.equal(request?.input.questions[1].externalUrl, 'https://example.com/auth');
  const reply = findRequest(turn.requests, 'POST', /\/session\/global\/form\/frm_mcp\/reply$/);
  assert.deepEqual(reply?.body.answer, { scope: 'staged', auth: true });
  assert.equal(reply?.directory, projectDir);
  assert.equal(opencodeRuntime.permissions.listPending('app-session').length, 0);
});

test('headless runs cancel global MCP forms in their owning directory', async () => {
  const turn = await runTurn({
    permissionMode: 'bypassPermissions',
    scenario: { steps: [{ type: 'form', directory: projectDir, form: {
      id: 'frm_headless', sessionID: 'global', title: 'Input', metadata: { kind: 'mcp-elicitation' },
      fields: [{ key: 'value', type: 'string' }],
    } }] },
  });
  assert.equal(turn.error, null);
  assert.ok(findRequest(turn.requests, 'DELETE', /\/session\/global\/form\/frm_headless$/));
  assert.equal(turn.frames.some((frame) => frame.kind === 'permission_request'), false);
});

test('an external V2 interruption terminates the run instead of waiting for session.idle', async () => {
  const turn = await runTurn({ scenario: { steps: [{ type: 'interrupt' }] } });
  assert.match(String(turn.error), /execution interrupted/);
  assert.equal(turn.frames.at(-1)?.kind, 'complete');
  assert.equal(turn.frames.at(-1)?.exitCode, 1);
});

test('a new session runs on a private, authenticated server that stops with the turn', async () => {
  const turn = await runTurn({
    scenario: { newSessionId: 'ses_new', steps: [{ type: 'reasoning', text: 'thinking it over' }, { type: 'text', text: 'assistant response' }] },
  });

  assert.equal(turn.error, null);
  assert.deepEqual(kinds(turn.frames), ['session_created', 'thinking', 'text', 'stream_end', 'complete']);
  assert.equal(turn.frames[0].newSessionId, 'ses_new');
  assert.equal(turn.writer.sessionId, 'ses_new');
  assert.equal(turn.frames[2].content, 'assistant response');
  assert.equal(turn.frames.at(-1)?.exitCode, 0);

  // Every call carried the turn's password and the chat's project directory.
  assert.ok(turn.requests.length > 0);
  for (const entry of turn.requests) {
    assert.match(String(entry.authorization), /^Basic /);
  }
  const prompt = findRequest(turn.requests, 'POST', /^\/api\/session\/ses_new\/prompt$/);
  const created = findRequest(turn.requests, 'POST', /^\/api\/session$/);
  assert.deepEqual(created?.body.model, { providerID: 'github-copilot', id: 'gpt-5.6-terra' });
  assert.deepEqual(created?.body.location, { directory: projectDir });
  assert.ok(created?.body.metadata.cloudcliSessionId);
  assert.equal(prompt?.body.text, 'Hi');

  // Loopback only, with a password of its own that never stays in CloudCLI's environment.
  assert.ok(turn.started?.args.includes('--hostname=127.0.0.1'));
  assert.equal(turn.started?.passwordSet, true);
  assert.equal(process.env.OPENCODE_SERVER_PASSWORD, undefined);
  assert.equal(process.env.CLOUDCLI_OPENCODE_OWNER_PID, undefined);

  assert.ok(turn.serverPid, 'the fake server reported its pid');
  assert.ok(await waitForExit(turn.serverPid!), 'the turn\'s server process is gone');
});

test('an attachment-only message uses V2 native files', async () => {
  const turn = await runTurn({
    command: '',
    files: [{ path: path.join(projectDir, 'brief.pdf'), name: 'brief.pdf', mimeType: 'application/pdf' }],
    scenario: { steps: [{ type: 'text', text: 'read it' }] },
  });

  assert.equal(turn.error, null);
  const prompt = findRequest(turn.requests, 'POST', /\/prompt$/);
  assert.equal(prompt?.body.text, '');
  assert.deepEqual(prompt?.body.files, [{ uri: new URL(`file://${projectDir}/brief.pdf`).href, name: 'brief.pdf' }]);
});

test('a permission request reaches the chat and is answered once', async () => {
  let pendingWhileAsked: unknown[] = [];
  const turn = await runTurn({
    appSessionId: 'app-once',
    scenario: { steps: [permissionStep(['git status'], ['git status *']), { type: 'text', text: 'done' }] },
    onFrame: (frame) => {
      if (frame.kind === 'permission_request') {
        pendingWhileAsked = opencodeRuntime.permissions.listPending('app-once');
        return { allow: true };
      }
    },
  });

  assert.equal(turn.error, null);
  const request = turn.frames.find((frame) => frame.kind === 'permission_request');
  assert.equal(request?.toolName, 'shell');
  assert.deepEqual(request?.context, { patterns: ['git status'], always: ['git status *'] });
  assert.deepEqual(request?.input, { command: 'git status', patterns: ['git status'] });
  // A client that subscribes while the prompt is open gets it replayed.
  assert.equal((pendingWhileAsked[0] as Frame | undefined)?.requestId, 'per_1');

  assert.deepEqual(findRequest(turn.requests, 'POST', /\/permission\/per_1\/reply$/)?.body, { decision: 'once' });
  assert.ok(kinds(turn.frames).includes('permission_resolved'));
  const tool = turn.frames.find((frame) => frame.kind === 'tool_use');
  assert.equal(tool?.toolResult?.isError, false);
  assert.equal(turn.frames.at(-1)?.exitCode, 0);
  assert.deepEqual(opencodeRuntime.permissions.listPending('app-once'), []);
});

test('Always allow is remembered for the same chat, not for others', async () => {
  const first = await runTurn({
    appSessionId: 'app-always',
    scenario: { newSessionId: 'ses_always', steps: [permissionStep(['git status'], ['git status *'])] },
    onFrame: (frame) => (frame.kind === 'permission_request' ? { allow: true, rememberEntry: 'always' } : undefined),
  });
  assert.deepEqual(findRequest(first.requests, 'POST', /\/permission\/per_1\/reply$/)?.body, { decision: 'always' });

  // The next turn's server knows nothing of it, so CloudCLI answers for the chat.
  const second = await runTurn({
    appSessionId: 'app-always',
    resumeSessionId: 'ses_always',
    scenario: { sessions: { ses_always: {} }, steps: [permissionStep(['git status --short'], ['git status *'], 'shell', 'per_2')] },
    onFrame: (frame) => (frame.kind === 'permission_request' ? { allow: false } : undefined),
  });
  assert.equal(second.frames.some((frame) => frame.kind === 'permission_request'), false);
  assert.deepEqual(findRequest(second.requests, 'POST', /\/permission\/per_2\/reply$/)?.body, { decision: 'once' });

  // A command the approval does not cover is still asked.
  const uncovered = await runTurn({
    appSessionId: 'app-always',
    resumeSessionId: 'ses_always',
    scenario: { sessions: { ses_always: {} }, steps: [permissionStep(['git push'], ['git push *'], 'shell', 'per_3')] },
    onFrame: (frame) => (frame.kind === 'permission_request' ? { allow: true } : undefined),
  });
  assert.equal(uncovered.frames.filter((frame) => frame.kind === 'permission_request').length, 1);

  const otherChat = await runTurn({
    appSessionId: 'app-other',
    scenario: { steps: [permissionStep(['git status'], ['git status *'], 'shell', 'per_4')] },
    onFrame: (frame) => (frame.kind === 'permission_request' ? { allow: true } : undefined),
  });
  assert.equal(otherChat.frames.filter((frame) => frame.kind === 'permission_request').length, 1);
});

test('Deny rejects the request, which ends the turn like OpenCode\'s own Reject', async () => {
  const turn = await runTurn({
    scenario: { steps: [permissionStep(['rm -rf build'], ['rm *']), { type: 'text', text: 'never reached' }] },
    onFrame: (frame) => (frame.kind === 'permission_request' ? { allow: false, message: 'User denied tool use' } : undefined),
  });

  assert.equal(turn.error, null);
  assert.deepEqual(findRequest(turn.requests, 'POST', /\/permission\/per_1\/reply$/)?.body, { decision: 'reject' });
  assert.equal(turn.frames.find((frame) => frame.kind === 'tool_use')?.toolResult?.isError, true);
  assert.equal(turn.frames.some((frame) => frame.kind === 'text'), false);
  assert.equal(turn.frames.at(-1)?.kind, 'complete');
});

test('a reply OpenCode has already settled is not a failure', async () => {
  // The chat's answer and OpenCode's own cascade raced: the reply gets the 404
  // OpenCode sends for a request it no longer knows.
  const turn = await runTurn({
    scenario: { replyNotFound: ['per_1'], steps: [permissionStep(['git push'], ['git push *']), { type: 'text', text: 'never reached' }] },
    onFrame: (frame) => (frame.kind === 'permission_request' ? { allow: true } : undefined),
  });

  assert.equal(turn.error, null);
  assert.ok(findRequest(turn.requests, 'POST', /\/permission\/per_1\/reply$/));
  assert.equal(turn.frames.some((frame) => frame.kind === 'error'), false);
  assert.equal(turn.frames.at(-1)?.exitCode, 0);
});

test('an unanswered permission is rejected once its timeout runs out', async () => {
  const turn = await runTurn({ scenario: { steps: [permissionStep(['make deploy'], ['make *'])] } });

  const cancelled = turn.frames.find((frame) => frame.kind === 'permission_cancelled');
  assert.equal(cancelled?.reason, 'timeout');
  assert.deepEqual(findRequest(turn.requests, 'POST', /\/permission\/per_1\/reply$/)?.body, { decision: 'reject' });
});

test('bypassPermissions answers permissions and questions without asking anyone', async () => {
  const turn = await runTurn({
    permissionMode: 'bypassPermissions',
    scenario: { steps: [permissionStep(['npm test'], ['npm *']), questionStep, { type: 'text', text: 'carried on' }] },
  });

  assert.equal(turn.error, null);
  assert.equal(turn.frames.some((frame) => frame.kind === 'permission_request'), false);
  assert.deepEqual(findRequest(turn.requests, 'POST', /\/permission\/per_1\/reply$/)?.body, { decision: 'once' });
  // Unanswered, so the agent carries on instead of the turn ending.
  assert.ok(findRequest(turn.requests, 'DELETE', /\/form\/que_1$/));
  // A bypassed turn does not touch the session's question rule.
  assert.ok(turn.requests.filter((request) => request.method === 'PATCH').every((request) => !request.body?.permission));
});

test('acceptEdits approves file edits and still asks for everything else', async () => {
  const turn = await runTurn({
    permissionMode: 'acceptEdits',
    scenario: { steps: [
      permissionStep(['src/app.ts'], ['*'], 'edit', 'per_edit'),
      permissionStep(['npm install'], ['npm *'], 'shell', 'per_bash'),
    ] },
    onFrame: (frame) => (frame.kind === 'permission_request' ? { allow: true } : undefined),
  });

  const asked = turn.frames.filter((frame) => frame.kind === 'permission_request').map((frame) => frame.toolName);
  assert.deepEqual(asked, ['shell']);
  assert.deepEqual(findRequest(turn.requests, 'POST', /\/permission\/per_edit\/reply$/)?.body, { decision: 'once' });
});

test('plan mode prompts the plan agent', async () => {
  const turn = await runTurn({ permissionMode: 'plan', scenario: { defaultAgent: 'review', steps: [{ type: 'text', text: 'a plan' }] } });

  assert.equal(findRequest(turn.requests, 'POST', /^\/api\/session$/)?.body.agent, 'plan');
  assert.equal(findRequest(turn.requests, 'POST', /^\/api\/session$/)?.body.metadata.cloudcliPreviousAgent, 'review');
});

test('normal mode uses the configured V2 default agent', async () => {
  const turn = await runTurn({ scenario: { defaultAgent: 'review', steps: [{ type: 'text', text: 'ok' }] } });
  assert.equal(turn.error, null);
  assert.equal(findRequest(turn.requests, 'POST', /^\/api\/session$/)?.body.agent, 'review');
});

test('a question is answered with one label list per question and shown as a question card', async () => {
  const turn = await runTurn({
    scenario: { steps: [questionStep] },
    onFrame: (frame) => (frame.kind === 'permission_request'
      ? { allow: true, updatedInput: { answers: [['Red'], ['Small', 'Large, wide']] } }
      : undefined),
  });

  const request = turn.frames.find((frame) => frame.kind === 'permission_request');
  assert.equal(request?.toolName, 'AskUserQuestion');
  assert.deepEqual(request?.context, { answerFormat: 'label-lists' });
  assert.equal(request?.input.questions[1].multiSelect, true);
  assert.equal(request?.input.questions[0].question, 'Which color?');
  assert.equal(request?.input.questions[0].header, 'Color');
  assert.deepEqual(
    findRequest(turn.requests, 'POST', /\/form\/que_1\/reply$/)?.body,
    { answer: { q0: 'Red', q1: ['Small', 'Large, wide'] } },
  );

  const card = turn.frames.find((frame) => frame.kind === 'tool_use');
  assert.equal(card?.toolName, 'AskUserQuestion');
  assert.deepEqual(card?.toolInput.answers, { 'Which color?': 'Red', 'Which sizes?': 'Small, Large, wide' });
});

test('dismissing a question rejects it', async () => {
  const turn = await runTurn({
    scenario: { steps: [questionStep, { type: 'text', text: 'never reached' }] },
    onFrame: (frame) => (frame.kind === 'permission_request' ? { allow: false } : undefined),
  });

  assert.ok(findRequest(turn.requests, 'DELETE', /\/form\/que_1$/));
  assert.equal(turn.frames.some((frame) => frame.kind === 'text'), false);
});

test('stopping a turn withdraws its prompt, aborts the session and settles after the stop', async () => {
  let abortReturnedAt = 0;
  let abortResult: boolean | null = null;
  const turnPromise = runTurn({
    appSessionId: 'app-abort',
    scenario: { steps: [permissionStep(['sleep 100'], ['sleep *'])] },
    onFrame: (frame) => {
      if (frame.kind === 'permission_request') {
        void opencodeRuntime.abort('app-abort').then((result: boolean) => {
          abortResult = result;
          abortReturnedAt = performance.now();
        });
      }
    },
  });
  const turn = await turnPromise;
  const settledAt = performance.now();

  assert.equal(turn.error, null);
  assert.equal(abortResult, true);
  assert.ok(abortReturnedAt > 0 && abortReturnedAt <= settledAt, 'the turn settles only after its abort returned');
  assert.equal(turn.frames.find((frame) => frame.kind === 'permission_cancelled')?.reason, 'cancelled');
  assert.ok(findRequest(turn.requests, 'POST', /^\/api\/session\/[^/]+\/interrupt$/));
  // The chat's abort handler sends the terminal complete, not the runtime.
  assert.equal(turn.frames.some((frame) => frame.kind === 'complete' || frame.kind === 'error'), false);
  assert.ok(await waitForExit(turn.serverPid!), 'the stopped turn\'s server process is gone');
  assert.equal(await opencodeRuntime.abort('app-abort'), false);
});

test('a second stop waits for the first and reports the turn stopped only once it is', async () => {
  const results: boolean[] = [];
  let abortsSettledAt = 0;
  const turn = await runTurn({
    appSessionId: 'app-double-stop',
    // OpenCode takes a while to confirm the first stop.
    scenario: { abortDelayMs: 600, steps: [permissionStep(['sleep 100'], ['sleep *'])] },
    onFrame: (frame) => {
      if (frame.kind === 'permission_request') {
        void Promise.all([
          opencodeRuntime.abort('app-double-stop'),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(opencodeRuntime.abort('app-double-stop')), 50)),
        ]).then((values) => {
          results.push(...values);
          abortsSettledAt = performance.now();
        });
      }
    },
  });
  const settledAt = performance.now();

  assert.equal(turn.error, null);
  assert.deepEqual(results, [true, true]);
  assert.ok(abortsSettledAt > 0 && abortsSettledAt <= settledAt);
  assert.equal(turn.frames.filter((frame) => frame.kind === 'complete').length, 0);
});

test('a request raised while the turn is stopping never reaches the chat', async () => {
  const turn = await runTurn({
    appSessionId: 'app-late-ask',
    scenario: {
      // The abort takes a moment, so the late question arrives while it is pending.
      abortDelayMs: 300,
      askOnAbort: { id: 'que_late', questions: questionStep.questions },
      steps: [permissionStep(['sleep 100'], ['sleep *'])],
    },
    onFrame: (frame) => {
      if (frame.kind === 'permission_request' && frame.requestId === 'per_1') {
        void opencodeRuntime.abort('app-late-ask');
      }
    },
  });

  assert.equal(turn.frames.some((frame) => frame.requestId === 'que_late'), false);
  assert.deepEqual(opencodeRuntime.permissions.listPending('app-late-ask'), []);
});

test('requests OpenCode settles itself are withdrawn from the chat', async () => {
  const turn = await runTurn({
    appSessionId: 'app-cascade',
    scenario: { steps: [{
      type: 'parallel-permissions',
      requests: [
        { id: 'per_a', permission: 'shell', patterns: ['npm test'], always: ['npm *'] },
        { id: 'per_b', permission: 'shell', patterns: ['npm run lint'], always: ['npm *'] },
      ],
    }] },
    // Only the first is answered; OpenCode's reject cascade settles the second.
    onFrame: (frame) => (frame.kind === 'permission_request' && frame.requestId === 'per_a' ? { allow: false } : undefined),
  });

  const settledB = turn.frames.find((frame) => frame.requestId === 'per_b' && frame.kind !== 'permission_request');
  assert.equal(settledB?.kind, 'permission_resolved');
  assert.equal(findRequest(turn.requests, 'POST', /\/permission\/per_b\/reply$/), undefined);
  assert.deepEqual(opencodeRuntime.permissions.listPending('app-cascade'), []);
});

test('a message that cannot be normalized fails explicitly', async () => {
  const turn = await runTurn({
    scenario: { steps: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'still answered' }] },
    normalizeMessage: (raw, sessionId) => {
      if ((raw as any).message?.content?.[0]?.type === 'reasoning') {
        throw new Error('cannot normalize this one');
      }
      return sessionsProvider.normalizeMessage(raw, sessionId);
    },
  });

  assert.match(String(turn.error?.message), /cannot normalize/);
  assert.equal(turn.frames.at(-1)?.exitCode, 1);
});

test('turn servers a killed CloudCLI left running are stopped, and nothing else', { skip: process.platform !== 'linux' }, async () => {
  const deadOwner = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => deadOwner.once('exit', resolve));
  const keepAlive = 'setInterval(() => {}, 1000)';
  const start = (args: string[], ownerPid: number) => spawn(process.execPath, ['-e', keepAlive, ...args], {
    env: { ...process.env, CLOUDCLI_OPENCODE_OWNER_PID: String(ownerPid) },
    stdio: 'ignore',
  });
  const orphan = start(['serve', '--hostname=127.0.0.1', '--port=1'], deadOwner.pid!);
  const ownedByLiveCloudCli = start(['serve', '--hostname=127.0.0.1', '--port=2'], process.pid);
  const leftoverCommand = start(['npm', 'run', 'dev'], deadOwner.pid!);
  await new Promise((resolve) => setTimeout(resolve, 300));

  try {
    assert.ok(await reapOrphanedOpenCodeServers() >= 1);
    assert.ok(await waitForExit(orphan.pid!), 'the orphaned turn server is stopped');
    assert.equal(isProcessAlive(ownedByLiveCloudCli.pid!), true, 'a live CloudCLI\'s server is left alone');
    assert.equal(isProcessAlive(leftoverCommand.pid!), true, 'a command the agent left running is left alone');
  } finally {
    for (const child of [orphan, ownedByLiveCloudCli, leftoverCommand]) {
      child.kill('SIGKILL');
    }
  }
});

test('the leftover-server sweep only trusts owner pids from its own PID namespace', { skip: process.platform !== 'linux' }, async () => {
  // A CloudCLI on the host also sees a container's processes in /proc; their
  // owner pid is the container's and would look dead from the host.
  const deadOwner = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => deadOwner.once('exit', resolve));
  const keepAlive = 'setInterval(() => {}, 1000)';
  const sameNamespace = spawn(process.execPath, ['-e', keepAlive], { stdio: 'ignore' });
  const otherNamespace = spawn(process.execPath, ['-e', keepAlive], { stdio: 'ignore' });

  const procRoot = path.join(tempRoot, 'fake-proc');
  const addProcess = async (pid: number, namespace: string) => {
    const dir = path.join(procRoot, String(pid));
    await mkdir(path.join(dir, 'ns'), { recursive: true });
    await writeFile(path.join(dir, 'environ'), `PATH=/usr/bin\0CLOUDCLI_OPENCODE_OWNER_PID=${deadOwner.pid}\0`);
    await writeFile(path.join(dir, 'cmdline'), 'opencode\0serve\0--hostname=127.0.0.1\0--port=4242\0');
    await symlink(namespace, path.join(dir, 'ns', 'pid'));
  };
  await mkdir(path.join(procRoot, 'self', 'ns'), { recursive: true });
  await symlink('pid:[4026531836]', path.join(procRoot, 'self', 'ns', 'pid'));
  await addProcess(sameNamespace.pid!, 'pid:[4026531836]');
  await addProcess(otherNamespace.pid!, 'pid:[4026532999]');

  try {
    // Without its own namespace to compare against, it stops nothing.
    await mkdir(path.join(tempRoot, 'proc-without-self'), { recursive: true });
    assert.equal(await reapOrphanedOpenCodeServers(path.join(tempRoot, 'proc-without-self')), 0);

    assert.equal(await reapOrphanedOpenCodeServers(procRoot), 1);
    assert.ok(await waitForExit(sameNamespace.pid!), 'the leftover server of this namespace is stopped');
    assert.equal(isProcessAlive(otherNamespace.pid!), true, 'a process of another PID namespace is left alone');
  } finally {
    sameNamespace.kill('SIGKILL');
    otherNamespace.kill('SIGKILL');
  }
});

test('resuming a V2 session selects its requested model and agent before prompting', async () => {
  const resumed = await runTurn({
    resumeSessionId: 'ses_existing',
    scenario: { sessions: { ses_existing: {} }, steps: [{ type: 'text', text: 'hi' }] },
  });
  assert.equal(resumed.error, null);
  assert.equal(resumed.frames.some((frame) => frame.kind === 'session_created'), false);
  assert.deepEqual(findRequest(resumed.requests, 'POST', /\/ses_existing\/model$/)?.body,
    { model: { providerID: 'github-copilot', id: 'gpt-5.6-terra' } });
});

test('a failed first turn backfilled with its app UUID still creates a native V2 session', async () => {
  const id = '85d76f23-cac4-48b9-9b8d-f67606c0a5da';
  const turn = await runTurn({ appSessionId: id, resumeSessionId: id,
    scenario: { newSessionId: 'ses_retry', steps: [{ type: 'text', text: 'ok' }] } });
  assert.equal(turn.error, null);
  assert.equal(turn.writer.sessionId, 'ses_retry');
  assert.ok(findRequest(turn.requests, 'POST', /^\/api\/session$/));
});

test('a prompt OpenCode refuses fails the turn', async () => {
  const turn = await runTurn({ scenario: { promptStatus: 400, steps: [] } });

  assert.match(String(turn.error?.message), /The prompt was refused/);
  assert.deepEqual(kinds(turn.frames), ['session_created', 'error', 'complete']);
  assert.equal(turn.frames.at(-1)?.exitCode, 1);
});

test('an error reported before the turn runs ends it with that error, once', async () => {
  const turn = await runTurn({ scenario: { steps: [{ type: 'error', name: 'ProviderModelNotFoundError', message: 'Model not found: x/y' }] } });

  assert.match(String(turn.error?.message), /Model not found/);
  assert.equal(turn.frames.filter((frame) => frame.kind === 'error').length, 1);
  assert.equal(turn.frames.at(-1)?.exitCode, 1);
});

test('a server that dies mid-turn fails the turn', async () => {
  const turn = await runTurn({ scenario: { steps: [{ type: 'text', text: 'partial' }, { type: 'crash' }] } });

  assert.ok(turn.error);
  assert.match(String(turn.frames.find((frame) => frame.kind === 'error')?.content), /OpenCode server/);
  assert.equal(turn.frames.at(-1)?.exitCode, 1);
});

test('V1 and unsupported major versions are refused before prompting', async () => {
  for (const version of ['1.19.5', '2.1.3', '3.0.0']) {
    const turn = await runTurn({ scenario: { version, steps: [] } });
    assert.match(String(turn.error?.message), /requires OpenCode V2/);
    assert.equal(turn.frames.at(-1)?.exitCode, 1);
    assert.equal(findRequest(turn.requests, 'POST', /\/prompt$/), undefined);
  }
});

test('a missing CLI is reported as not installed', async () => {
  const pathKey = findEnvKey('PATH');
  const previousPath = process.env[pathKey];
  process.env[pathKey] = path.join(tempRoot, 'empty-bin');
  try {
    const turn = await runTurn({ installed: false, scenario: { steps: [] } });
    assert.match(String(turn.frames.find((frame) => frame.kind === 'error')?.content), /OpenCode CLI is not installed/);
    assert.equal(turn.frames.at(-1)?.exitCode, 1);
  } finally {
    process.env[pathKey] = previousPath;
  }
});

test('permission modes map onto automatic replies', () => {
  assert.equal(resolveAutomaticPermissionReply('bypassPermissions', 'shell'), 'once');
  assert.equal(resolveAutomaticPermissionReply('acceptEdits', 'edit'), 'once');
  assert.equal(resolveAutomaticPermissionReply('acceptEdits', 'shell'), null);
  assert.equal(resolveAutomaticPermissionReply('plan', 'shell'), null);
  assert.equal(resolveAutomaticPermissionReply('default', 'external_directory'), null);
  assert.equal(resolveAutomaticPermissionReply(undefined, 'shell'), null);

  assert.equal(toOpenCodePermissionReply({ allow: true }), 'once');
  assert.equal(toOpenCodePermissionReply({ allow: true, rememberEntry: 'always' }), 'always');
  assert.equal(toOpenCodePermissionReply({ allow: false, rememberEntry: 'always' }), 'reject');
});

test('remembered approvals cover a request only when every pattern matches', () => {
  const approvals = [{ permission: 'shell', pattern: 'git status *' }, { permission: 'external_directory', pattern: '/home/u/.cloudcli/assets/*' }];

  assert.equal(isCoveredByApprovals(approvals, 'shell', ['git status']), true);
  assert.equal(isCoveredByApprovals(approvals, 'shell', ['git status --short']), true);
  assert.equal(isCoveredByApprovals(approvals, 'shell', ['git statusx']), false);
  assert.equal(isCoveredByApprovals(approvals, 'shell', ['git status', 'git push']), false);
  assert.equal(isCoveredByApprovals(approvals, 'edit', ['git status']), false);
  assert.equal(isCoveredByApprovals(approvals, 'external_directory', ['/home/u/.cloudcli/assets/*']), true);
  assert.equal(isCoveredByApprovals(undefined, 'shell', ['git status']), false);
  assert.equal(isCoveredByApprovals(approvals, 'shell', []), false);
});

test('question answers are read as one label list per question', () => {
  const questions = [{ question: 'Which color?' }, { question: 'Which sizes?' }];

  assert.deepEqual(readQuestionAnswers({ answers: [['Red'], ['Small', 'Large, wide']] }, questions), [['Red'], ['Small', 'Large, wide']]);
  assert.deepEqual(readQuestionAnswers({ answers: [['Red']] }, questions), [['Red'], []]);
  assert.deepEqual(readQuestionAnswers({ answers: { 'Which color?': 'Blue', 'Which sizes?': '' } }, questions), [['Blue'], []]);
  assert.deepEqual(readQuestionAnswers(undefined, questions), [[], []]);
});


test('ordinary resume preserves a native custom agent', async () => {
  const turn = await runTurn({
    resumeSessionId: 'ses_custom',
    scenario: { sessions: { ses_custom: { agent: 'reviewer' } }, steps: [] },
  });
  assert.equal(turn.error, null);
  assert.equal(findRequest(turn.requests, 'POST', /\/agent$/), undefined);
});

test('text deltas and tool start events reach the chat before completion', async () => {
  const turn = await runTurn({
    scenario: {
      messages: { msg_running: { id: 'msg_running', type: 'assistant', time: { created: 1 }, content: [
        { type: 'tool', id: 'tool_1', name: 'shell', state: { status: 'running', input: { command: 'sleep 5' } } },
      ] } },
      events: [
        { type: 'session.text.delta', data: { sessionID: 'ses_fake_new', assistantMessageID: 'msg_stream', ordinal: 0, delta: 'Hello' } },
        { type: 'session.text.delta', data: { sessionID: 'ses_fake_new', assistantMessageID: 'msg_stream', ordinal: 0, delta: ' world' } },
        { type: 'session.tool.called', data: { sessionID: 'ses_fake_new', assistantMessageID: 'msg_running', id: 'tool_1' } },
        { type: 'session.tool.progress', data: { sessionID: 'ses_fake_new', assistantMessageID: 'msg_running', id: 'tool_1', metadata: { output: 'working' } } },
      ], steps: [],
    },
  });
  assert.equal(turn.error, null);
  assert.deepEqual(turn.frames.filter((f) => f.id === 'msg_stream_text_0').map((f) => f.content), ['Hello', 'Hello world']);
  assert.ok(turn.frames.some((f) => f.kind === 'tool_use' && f.toolId === 'tool_1' && !f.toolResult));
  assert.ok(turn.frames.some((f) => f.toolProgress === 'working'));
});


test('background children survive the foreground complete and can be stopped individually', async () => {
  let tasks: unknown[] = [];
  let stopping: Promise<boolean> | undefined;
  const turn = await runTurn({
    appSessionId: 'app-background',
    scenario: { steps: [{ type: 'background', childID: 'ses_background' }] },
    onFrame(frame) {
      if (frame.kind === 'complete') {
        tasks = opencodeRuntime.listBackgroundWork();
        stopping = opencodeRuntime.stopBackgroundTask('app-background', 'ses_background');
      }
    },
  });
  assert.equal(turn.error, null);
  assert.equal(await stopping, true);
  assert.equal(tasks.length, 1);
  assert.equal(turn.frames.filter((f) => f.kind === 'complete').length, 1);
  assert.ok(findRequest(turn.requests, 'POST', /\/ses_background\/interrupt$/));
  assert.deepEqual(opencodeRuntime.listBackgroundWork(), []);
  assert.ok(await waitForExit(turn.serverPid!));
});


test('a native plan session is preserved unless CloudCLI previously switched it into plan', async () => {
  const turn = await runTurn({
    resumeSessionId: 'ses_plan', permissionMode: 'default',
    scenario: { sessions: { ses_plan: { agent: 'plan' } }, steps: [] },
  });
  assert.equal(turn.error, null);
  assert.equal(findRequest(turn.requests, 'POST', /\/agent$/), undefined);
});

test('leaving a CloudCLI plan restores the saved agent instead of the current default', async () => {
  const turn = await runTurn({
    resumeSessionId: 'ses_plan', permissionMode: 'default',
    scenario: {
      defaultAgent: 'build',
      sessions: { ses_plan: { agent: 'plan', metadata: { cloudcliPreviousAgent: 'reviewer' } } },
      steps: [],
    },
  });
  assert.equal(turn.error, null);
  assert.equal(findRequest(turn.requests, 'POST', /\/agent$/)?.body.agent, 'reviewer');
  assert.equal(findRequest(turn.requests, 'PATCH', /\/ses_plan$/)?.body.metadata.cloudcliPreviousAgent, null);
});

test('detached child notifications survive a delay and finish their parent followup', async () => {
  const turn = await runTurn({ scenario: { steps: [{ type: 'detached-child', childID: 'ses_delayed' }] } });
  assert.equal(turn.error, null);
  assert.ok(turn.frames.some((frame) => frame.content === 'Background result received'));
  assert.equal(turn.frames.filter((frame) => frame.kind === 'complete').length, 1);
  assert.deepEqual(opencodeRuntime.listBackgroundWork(), []);
  assert.ok(await waitForExit(turn.serverPid!));
});

for (const stop of [false, true]) {
  test(`background shell stays alive through notification and followup (stop=${stop})`, async () => {
    let stopping: Promise<boolean> | undefined;
    let listed: ReturnType<typeof opencodeRuntime.listBackgroundWork> = [];
    const turn = await runTurn({
      scenario: { steps: [{ type: 'background-shell', shellID: 'shl_owned', stop }] },
      onFrame(frame) {
        if (frame.kind !== 'complete') return;
        listed = opencodeRuntime.listBackgroundWork();
        if (stop) stopping = opencodeRuntime.stopBackgroundTask('app-session', 'shl_owned');
      },
    });
    assert.equal(turn.error, null);
    assert.equal(listed[0]?.tasks[0]?.taskType, 'shell');
    assert.ok(turn.frames.some((frame) => frame.content === 'Background result received'));
    assert.equal(turn.frames.filter((frame) => frame.kind === 'complete').length, 1);
    if (stop) {
      assert.equal(await stopping, true);
      assert.ok(findRequest(turn.requests, 'DELETE', /\/shell\/shl_owned$/));
      assert.equal(findRequest(turn.requests, 'POST', /shl_owned\/interrupt$/), undefined);
    }
    assert.deepEqual(opencodeRuntime.listBackgroundWork(), []);
    assert.equal(await opencodeRuntime.stopBackgroundTask('app-session', 'shl_foreign'), false);
    assert.ok(await waitForExit(turn.serverPid!));
  });
}

test('native skill invocation attaches its id and retains arguments and files', async () => {
  const turn = await runTurn({ command: '/review check changes', files: [{ path: '/tmp/review.txt', name: 'review.txt' }],
    scenario: { skills: [{ id: 'review', name: 'Review', path: '/tmp/skill', description: 'Review code' }], steps: [] } });
  assert.equal(turn.error, null);
  const prompt = findRequest(turn.requests, 'POST', /\/prompt$/)?.body;
  assert.deepEqual(prompt.skills, [{ id: 'review', mention: { start: 0, end: 7, text: '/review' } }]);
  assert.equal(prompt.text, '/review check changes');
  assert.equal(prompt.files[0].name, 'review.txt');
});

test('native commands and compact use their own APIs', async () => {
  const command = await runTurn({ command: '/review check changes', scenario: { commands: [{ name: 'review' }], steps: [] } });
  assert.equal(command.error, null);
  assert.equal(findRequest(command.requests, 'POST', /\/prompt$/), undefined);
  assert.deepEqual(findRequest(command.requests, 'POST', /\/command$/)?.body, { name: 'review', text: 'check changes' });
  const compact = await runTurn({ command: '/compact', scenario: { steps: [] } });
  assert.equal(compact.error, null);
  assert.ok(findRequest(compact.requests, 'POST', /\/compact$/));
  assert.equal(findRequest(compact.requests, 'POST', /\/prompt$/), undefined);
});


test('explicit skill mentions remain unambiguous beside a native command and inside text', async () => {
  const turn = await runTurn({ command: 'Please /skill:review check changes', scenario: {
    commands: [{ name: 'review' }], skills: [{ id: 'review', name: 'Review', path: '/skill.md' }], steps: [],
  } });
  assert.equal(turn.error, null);
  assert.equal(findRequest(turn.requests, 'POST', /\/command$/), undefined);
  assert.deepEqual(findRequest(turn.requests, 'POST', /\/prompt$/)?.body.skills,
    [{ id: 'review', mention: { start: 7, end: 20, text: '/skill:review' } }]);
});

test('an unavailable explicit skill fails visibly instead of becoming ordinary prompt text', async () => {
  const turn = await runTurn({ command: '/skill:removed do work', scenario: { steps: [] } });
  assert.match(turn.error?.message ?? '', /skill not found: removed/);
  assert.equal(findRequest(turn.requests, 'POST', /\/prompt$/), undefined);
});


test('native menu waits for plugin activation and distinguishes command and skill collisions', async () => {
  setEnv('FAKE_OPENCODE_SCENARIO', JSON.stringify({ skills: [{ id: 'review', name: 'Review', path: '/skill.md' }],
    commands: [{ name: 'review' }], steps: [] }));
  setEnv('FAKE_OPENCODE_LOG', path.join(tempRoot, 'menu-requests.jsonl'));
  const { listOpenCodeInvocations } = await import('@/modules/providers/list/opencode/opencode-inputs.provider.js');
  const invocations = await listOpenCodeInvocations(projectDir);
  assert.deepEqual(invocations.map((entry) => [entry.name, entry.kind]),
    [['/compact', 'command'], ['/review', 'command'], ['/skill:review', 'skill']]);
});


test('a native command can carry a skill mention in its arguments', async () => {
  const turn = await runTurn({ command: '/review use /skill:checks', scenario: {
    commands: [{ name: 'review' }], skills: [{ id: 'checks', name: 'Checks', path: '/skill.md' }], steps: [],
  } });
  assert.equal(turn.error, null);
  assert.deepEqual(findRequest(turn.requests, 'POST', /\/command$/)?.body, {
    name: 'review', text: 'use /skill:checks',
    skills: [{ id: 'checks', mention: { start: 4, end: 17, text: '/skill:checks' } }],
  });
});
