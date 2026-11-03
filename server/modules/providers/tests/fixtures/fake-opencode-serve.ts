import fs from 'node:fs';
import http from 'node:http';

import type { FormInfo, ModelRef, SessionInfo } from '@opencode/client';

type PermissionRule = { permission: string; pattern: string; action: string };
type StoredSession = Partial<Pick<SessionInfo, 'agent' | 'model' | 'metadata' | 'parentID'>> & { permission?: PermissionRule[] };

type Step =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
    type: 'permission';
    id: string;
    permission: string;
    sessionID?: string;
    patterns: string[];
    always: string[];
    metadata?: Record<string, unknown>;
  }
  | { type: 'question'; id: string; sessionID?: string; questions: unknown[] }
  | { type: 'form'; form: FormInfo; directory: string }
  | { type: 'interrupt' }
  | { type: 'background'; childID: string }
  | { type: 'background-shell'; shellID: string; stop?: boolean }
  | { type: 'detached-child'; childID: string; missCompletionEvents?: boolean }
  /** Several requests asked at once; a reject of one rejects the rest, as OpenCode does. */
  | { type: 'parallel-permissions'; requests: Array<{ id: string; permission: string; patterns: string[]; always: string[] }> }
  | { type: 'error'; name: string; message: string }
  | { type: 'crash' }
  | { type: 'hang' };

type Scenario = {
  /** Id given to a session created through POST /session. */
  newSessionId?: string;
  /** Sessions GET /session/:id knows; any other id answers 404. */
  sessions?: Record<string, StoredSession>;
  events?: Array<{ type: string; data: Record<string, unknown>; location?: { directory: string } }>;
  agents?: Array<{ name: string; permission: PermissionRule[] }>;
  defaultAgent?: string;
  messages?: Record<string, any>;
  skills?: unknown[];
  commands?: unknown[];
  models?: unknown[];
  /** Answered with a status instead of 204, as OpenCode does for a bad prompt. */
  promptStatus?: number;
  /** Native validation can reject a reply without settling the form. */
  formReplyFailures?: number;
  /** Fail before applying a native mutation, allowing retry/state assertions on the same host. */
  agentSwitchFailures?: number;
  modelSwitchFailures?: number;
  metadataUpdateFailures?: number;
  /** Version /global/health reports; null makes the route missing, as before OpenCode 1.0.224. */
  version?: string | null;
  /** How long POST /session/:id/abort takes to answer. */
  abortDelayMs?: number;
  /**
   * Requests OpenCode has already settled by the time the chat's reply lands
   * (a cascade raced it): the reply gets the 404 OpenCode sends, and the
   * request is settled as rejected.
   */
  replyNotFound?: string[];
  /** A question OpenCode raises while the abort is being handled. */
  askOnAbort?: { id: string; questions: unknown[] };
  steps: Step[];
};

const args = process.argv.slice(2);
const readFlag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const scenario = JSON.parse(process.env.FAKE_OPENCODE_SCENARIO || '{"steps":[]}') as Scenario;
const logPath = process.env.FAKE_OPENCODE_LOG;
const password = process.env.OPENCODE_SERVER_PASSWORD;
const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';

const log = (entry: Record<string, unknown>) => {
  if (logPath) {
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  }
};

if (args[0] !== 'serve') {
  console.error(`fake opencode: unsupported command ${args.join(' ')}`);
  process.exit(2);
}

const streams = new Set<http.ServerResponse>();
const sessions = new Map(Object.entries(scenario.sessions ?? {}));
const waiting = new Map<string, (reply: { kind: 'permission' | 'question'; value: unknown }) => void>();
let catalogReady = false;
let eventCounter = 0;
let partCounter = 0;
let turnAborted: (() => void) | null = null;

const forms = new Map<string, any>();
const formDirectories = new Map<string, string>();
const messages = new Map<string, any>(Object.entries(scenario.messages ?? {}));
const emit = (type: string, properties: Record<string, any>, location?: { directory: string }) => {
  if (type === 'message.updated') return;
  if (type === 'session.error') {
    type = properties.error.name === 'MessageAbortedError' ? 'session.execution.interrupted' : 'session.execution.failed';
    properties = type === 'session.execution.interrupted'
      ? { sessionID: properties.sessionID, reason: 'user' }
      : { sessionID: properties.sessionID, error: { type: properties.error.name, message: properties.error.data.message } };
  }
  if (type === 'permission.asked') {
    properties = { id: properties.id, sessionID: properties.sessionID, action: properties.permission,
      resources: properties.patterns, save: properties.always, metadata: properties.metadata };
  }
  if (type === 'question.asked') {
    const form = { id: properties.id, sessionID: properties.sessionID, title: 'Question',
      fields: properties.questions.map((q: any, index: number) => ({
        key: `q${index}`, title: q.header, description: q.question, type: q.multiple ? 'multiselect' : 'string',
        options: q.options.map((option: any) => ({ ...option, value: option.label })),
        custom: q.custom,
      })) };
    forms.set(form.id, form);
    type = 'form.created';
    properties = { form };
  }
  if (type === 'session.shell.started') {
    messages.set(`msg_${eventCounter + 1}`, {
      id: `msg_${eventCounter + 1}`, type: 'shell', shellID: properties.shell.id,
      command: properties.shell.command, status: 'running', time: { created: Date.now() },
    });
  }
  if (type === 'session.shell.ended') {
    const message = [...messages.values()].find((entry) => entry.shellID === properties.shell.id);
    if (message) Object.assign(message, { status: properties.shell.status, exit: properties.shell.exit, output: properties.output });
  }
  const data = JSON.stringify({ id: `evt_${++eventCounter}`, created: Date.now(), type, data: properties, ...(location ? { location } : {}) });
  for (const stream of streams) {
    stream.write(`data: ${data}\n\n`);
  }
};

const emitPart = (sessionID: string, part: Record<string, any>) => {
  if (part.messageID === 'msg_user') return;
  const messageID = `msg_${++partCounter}`;
  const state = part.state;
  const content = part.type === 'tool' ? {
    type: 'tool', id: part.callID, name: part.tool,
    state: { ...state, content: [{ type: 'text', text: state.output ?? '' }],
      ...(state.error ? { error: { type: 'ToolError', message: state.error } } : {}) },
  } : part;
  const message = { id: messageID, type: 'assistant', time: { created: Date.now() },
    content: part.type === 'step-finish' ? [] : [content] };
  if (part.type === 'step-finish') (message.time as any).completed = Date.now();
  messages.set(messageID, message);
  const type = part.type === 'tool' ? (state.status === 'error' ? 'session.tool.failed' : 'session.tool.success')
    : part.type === 'step-finish' ? 'session.step.ended' : `session.${part.type}.ended`;
  emit(type, { sessionID, assistantMessageID: messageID, ordinal: 0, text: part.text });
};

const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage) => new Promise<unknown>((resolve) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    try {
      resolve(raw ? JSON.parse(raw) : undefined);
    } catch {
      resolve(raw);
    }
  });
});

/** Runs the scripted turn the way OpenCode's session loop reports it. */
async function runTurn(sessionID: string): Promise<void> {
  const aborted = new Promise<'aborted'>((resolve) => {
    turnAborted = () => resolve('aborted');
  });
  const now = Date.now();
  emit('message.updated', { sessionID, info: { id: 'msg_user', sessionID, role: 'user' } });
  emitPart(sessionID, { messageID: 'msg_user', type: 'text', text: 'the prompt' });

  for (const step of scenario.steps) {
    if (step.type === 'error') {
      // A prompt that fails before its loop starts never reports busy/idle.
      emit('session.error', { sessionID, error: { name: step.name, data: { message: step.message } } });
      return;
    }
  }

  emit('session.execution.started', { sessionID });
  for (const event of scenario.events ?? []) emit(event.type, event.data, event.location);
  emit('message.updated', { sessionID, info: { id: 'msg_assistant', sessionID, role: 'assistant' } });

  for (const step of scenario.steps) {
    if (step.type === 'background-shell' || step.type === 'detached-child') {
      const shell = step.type === 'background-shell';
      const taskID = shell ? step.shellID : step.childID;
      if (!shell) {
        sessions.set(taskID, { parentID: sessionID });
        emit('session.created', { sessionID: taskID, parentID: sessionID });
      }
      messages.set('msg_detached', {
        id: 'msg_detached', type: 'assistant', time: { created: Date.now() },
        content: [{ type: 'tool', name: shell ? 'shell' : 'subagent', id: 'tool_background', state: {
          status: 'completed', input: { background: true, command: 'sleep 1' },
          metadata: { status: 'running', ...(shell ? { shellID: taskID } : { sessionID: taskID }) }, content: [],
        } }],
      });
      emit('session.tool.success', { sessionID, assistantMessageID: 'msg_detached', id: 'tool_background' });
      emit('session.execution.succeeded', { sessionID });
      if (!shell && step.missCompletionEvents) return;
      if (shell && step.stop) await aborted;
      if (!shell) emit('session.execution.succeeded', { sessionID: taskID });
      // Native notifications can arrive well after child execution ends.
      await new Promise((resolve) => setTimeout(resolve, 700));
      emit('session.execution.started', { sessionID });
      emit('session.synthetic', { sessionID, text: 'background finished', metadata: {
        source: shell ? 'shell' : 'subagent', ...(shell ? { shellID: taskID } : { childID: taskID }), state: 'completed',
      } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      emitPart(sessionID, { messageID: 'msg_followup', type: 'text', text: 'Background result received' });
      emit('session.execution.succeeded', { sessionID });
      return;
    }
    if (step.type === 'background') {
      sessions.set(step.childID, { parentID: sessionID });
      emit('session.created', { sessionID: step.childID, parentID: sessionID });
      emit('session.execution.started', { sessionID: step.childID });
      emit('session.execution.succeeded', { sessionID });
      await aborted;
      emit('session.execution.interrupted', { sessionID: step.childID, reason: 'user' });
      return;
    }
    if (step.type === 'interrupt') {
      emit('session.execution.interrupted', { sessionID, reason: 'user' });
      return;
    }
    if (step.type === 'form') {
      const answer = new Promise((resolve) => waiting.set(step.form.id, resolve));
      forms.set(step.form.id, step.form);
      formDirectories.set(step.form.id, step.directory);
      emit('form.created', { form: step.form }, { directory: step.directory });
      await Promise.race([answer, aborted]);
      continue;
    }
    if (step.type === 'crash') {
      process.exit(1);
    }

    if (step.type === 'hang') {
      await aborted;
      emit('session.error', { sessionID, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
      emit('session.execution.succeeded', { sessionID });
      return;
    }

    if (step.type === 'text' || step.type === 'reasoning') {
      emitPart(sessionID, { type: step.type, text: step.text, time: { start: now, end: Date.now() } });
      continue;
    }

    if (step.type === 'permission') {
      const answer = new Promise<{ kind: string; value: unknown }>((resolve) => waiting.set(step.id, resolve));
      emit('permission.asked', {
        id: step.id,
        sessionID: step.sessionID ?? sessionID,
        permission: step.permission,
        patterns: step.patterns,
        always: step.always,
        metadata: step.metadata ?? {},
      });
      const outcome = await Promise.race([answer, aborted]);
      if (outcome === 'aborted') {
        emit('session.error', { sessionID, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
        emit('session.execution.succeeded', { sessionID });
        return;
      }
      const rejected = outcome.value === 'reject';
      emitPart(sessionID, {
        type: 'tool',
        callID: `call_${step.id}`,
        tool: step.permission,
        state: rejected
          ? { status: 'error', input: step.metadata ?? {}, error: 'The user rejected permission to use this specific tool call.', time: { start: now, end: Date.now() } }
          : { status: 'completed', input: step.metadata ?? {}, output: `ran ${step.patterns.join(' ')}`, title: step.permission, metadata: {}, time: { start: now, end: Date.now() } },
      });
      if (rejected) {
        break;
      }
      continue;
    }

    if (step.type === 'parallel-permissions') {
      const answers = step.requests.map((request) => {
        const answer = new Promise<{ kind: string; value: unknown }>((resolve) => waiting.set(request.id, resolve));
        emit('permission.asked', { ...request, sessionID, metadata: {} });
        return answer;
      });
      const first = await Promise.race([Promise.race(answers), aborted]);
      if (first === 'aborted') {
        emit('session.execution.succeeded', { sessionID });
        return;
      }
      if (first.value === 'reject') {
        // OpenCode rejects every other pending request of the session too.
        for (const request of step.requests) {
          const resolve = waiting.get(request.id);
          if (resolve) {
            waiting.delete(request.id);
            emit('permission.replied', { sessionID, requestID: request.id, reply: 'reject' });
            resolve({ kind: 'permission', value: 'reject' });
          }
        }
        break;
      }
      await Promise.all(answers);
      continue;
    }

    if (step.type === 'question') {
      const answer = new Promise<{ kind: string; value: unknown }>((resolve) => waiting.set(step.id, resolve));
      emit('question.asked', { id: step.id, sessionID: step.sessionID ?? sessionID, questions: step.questions });
      const outcome = await Promise.race([answer, aborted]);
      if (outcome === 'aborted') {
        emit('session.execution.succeeded', { sessionID });
        return;
      }
      const dismissed = outcome.value === null;
      emitPart(sessionID, {
        type: 'tool',
        callID: `call_${step.id}`,
        tool: 'question',
        state: dismissed
          ? { status: 'error', input: { questions: step.questions }, error: 'The user dismissed this question', time: { start: now, end: Date.now() } }
          : { status: 'completed', input: { questions: step.questions }, output: 'User has answered your questions', title: 'Asked', metadata: { answers: outcome.value }, time: { start: now, end: Date.now() } },
      });
      if (dismissed) {
        break;
      }
    }
  }

  emitPart(sessionID, { type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
  emit('session.execution.succeeded', { sessionID });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake');
  const body = req.method === 'GET' ? undefined : await readBody(req);
  const authorization = req.headers.authorization ?? null;
  // GET requests carry the directory as a query parameter, the others as an
  // encoded header; OpenCode decodes both.
  const directoryHeader = req.headers['x-opencode-directory'];
  log({
    method: req.method,
    path: url.pathname,
    directory: url.searchParams.get('location[directory]')
      ?? (typeof directoryHeader === 'string' ? decodeURIComponent(directoryHeader) : null),
    authorization,
    body,
  });

  if (password && authorization !== `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Secure Area"' });
    res.end();
    return;
  }

  const path = url.pathname.replace(/^\/api/, '');
  let match: RegExpExecArray | null;

  if (req.method === 'GET' && path === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    streams.add(res);
    res.write(`data: ${JSON.stringify({ id: 'evt_0', type: 'server.connected', data: {} })}\n\n`);
    req.on('close', () => streams.delete(res));
    return;
  }

  if (req.method === 'POST' && path === '/session') {
    const id = scenario.newSessionId ?? 'ses_fake_new';
    const session = { ...body as StoredSession };
    sessions.set(id, session);
    sendJson(res, 200, { data: { id, projectID: 'prj_test', title: 'New session', ...session } });
    return;
  }

  if (path !== '/session/active' && (match = /^\/session\/([^/]+)$/.exec(path))) {
    const session = sessions.get(match[1]);
    if (!session) {
      sendJson(res, 404, { name: 'NotFoundError', data: { message: `Session not found: ${match[1]}` } });
      return;
    }
    if (req.method === 'PATCH') {
      if (scenario.metadataUpdateFailures && 'metadata' in (body as object)) {
        scenario.metadataUpdateFailures -= 1;
        sendJson(res, 500, { name: 'InternalError', data: { message: 'Injected metadata update failure' } });
        return;
      }
      const added = (body as { permission?: PermissionRule[] } | undefined)?.permission ?? [];
      session.permission = [...(session.permission ?? []), ...added];
      Object.assign(session, body);
      res.writeHead(204);
      res.end();
      return;
    }
    sendJson(res, 200, { data: { id: match[1], projectID: 'prj_test', title: 'Session', ...session } });
    return;
  }

  if (req.method === 'GET' && path === '/session/active') {
    sendJson(res, 200, { data: {} });
    return;
  }

  if (req.method === 'GET' && path === '/info') {
    if (scenario.version === null) {
      sendJson(res, 404, { name: 'NotFoundError', data: { message: 'No route' } });
      return;
    }
    sendJson(res, 200, { healthy: true, version: scenario.version ?? '2.1.4' });
    return;
  }

  if (req.method === 'GET' && path === '/agent') {
    sendJson(res, 200, (scenario.agents ?? [
      { name: 'build', permission: [{ permission: 'question', pattern: '*', action: 'allow' }] },
      { name: 'plan', permission: [{ permission: 'question', pattern: '*', action: 'allow' }] },
    ]).map((agent) => ({ ...agent, mode: 'primary', options: {} })));
    return;
  }

  if (req.method === 'GET' && ['/model', '/skill', '/command'].includes(path)) {
    if (path === '/model') catalogReady = true;
    if (!catalogReady) {
      sendJson(res, 200, { location: { directory: directoryHeader }, data: [] });
      return;
    }
    const data = path === '/skill' ? scenario.skills ?? [] : path === '/command' ? scenario.commands ?? [] : scenario.models ?? [
      { id: 'gpt-5.6-terra', providerID: 'github-copilot', limit: { context: 128000 } },
    ];
    sendJson(res, 200, { location: { directory: directoryHeader }, data });
    return;
  }
  if (req.method === 'GET' && path === '/model/default') {
    sendJson(res, 200, { location: { directory: directoryHeader }, data: scenario.models?.[0] ?? null });
    return;
  }
  if (req.method === 'DELETE' && path.startsWith('/shell/')) {
    turnAborted?.();
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && path === '/config') {
    sendJson(res, 200, [{ type: 'document', info: { default_agent: scenario.defaultAgent ?? 'build' } }]);
    return;
  }

  if (req.method === 'POST' && (match = /^\/session\/([^/]+)\/(prompt|command|compact)$/.exec(path))) {
    if (scenario.promptStatus) {
      sendJson(res, scenario.promptStatus, { name: 'BadRequest', data: { message: 'The prompt was refused' } });
      return;
    }
    if (match[2] === 'command') {
      res.writeHead(204);
      res.end();
    } else {
      sendJson(res, 200, { data: { id: 'inbox_1', sessionID: match[1], type: 'user' } });
    }
    void runTurn(match[1]);
    return;
  }

  if (req.method === 'POST' && (match = /^\/session\/([^/]+)\/interrupt$/.exec(path))) {
    if (scenario.askOnAbort) {
      emit('question.asked', { ...scenario.askOnAbort, sessionID: match[1] });
    }
    if (scenario.abortDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, scenario.abortDelayMs));
    }
    turnAborted?.();
    sendJson(res, 200, true);
    return;
  }

  if ((match = /^\/session\/([^/]+)\/(permission|form)\/([^/]+)(?:\/(reply))?$/.exec(path))) {
    const [, sessionID, kind, requestID] = match;
    const resolve = waiting.get(requestID);
    if (sessionID === 'global' && decodeURIComponent(String(directoryHeader ?? '')) !== formDirectories.get(requestID)) {
      sendJson(res, 404, { _tag: 'NotFoundError', message: 'Wrong form location' });
      return;
    }
    if (!resolve || scenario.replyNotFound?.includes(requestID)) {
      resolve?.({ kind: 'permission', value: 'reject' });
      sendJson(res, 404, { _tag: 'NotFoundError', message: 'Request not found' });
      return;
    }
    if (kind === 'form' && req.method !== 'DELETE' && scenario.formReplyFailures) {
      scenario.formReplyFailures -= 1;
      sendJson(res, 400, { _tag: 'InvalidRequestError', message: 'The form answer failed native validation.' });
      return;
    }
    waiting.delete(requestID);
    const payload = body as any;
    const answers = forms.get(requestID)?.fields.map((field: any) => {
      const value = payload?.answer?.[field.key];
      return Array.isArray(value) ? value : value === undefined ? [] : [value];
    });
    const value = kind === 'permission' ? payload?.decision : req.method === 'DELETE' ? null : answers;
    emit(kind === 'permission' ? 'permission.replied' : value === null ? 'form.cancelled' : 'form.replied',
      { sessionID, requestID, id: requestID, reply: value });
    resolve({ kind: kind === 'permission' ? 'permission' : 'question', value });
    res.writeHead(204);
    res.end();
    return;
  }
  if ((match = /^\/session\/([^/]+)\/message\/([^/]+)$/.exec(path))) {
    sendJson(res, 200, { data: messages.get(match[2]) });
    return;
  }
  if (req.method === 'POST' && (match = /^\/session\/([^/]+)\/(agent|model)$/.exec(path))) {
    const session = sessions.get(match[1]);
    if (!session) {
      sendJson(res, 404, { name: 'NotFoundError', data: { message: 'Session not found' } });
      return;
    }
    const failureKey = match[2] === 'agent' ? 'agentSwitchFailures' : 'modelSwitchFailures';
    if (scenario[failureKey]) {
      scenario[failureKey] -= 1;
      sendJson(res, 500, { name: 'InternalError', data: { message: `Injected ${match[2]} switch failure` } });
      return;
    }
    if (match[2] === 'agent') {
      const previous = session.agent;
      session.agent = (body as { agent: string }).agent;
      emit('session.agent.selected', { sessionID: match[1], agent: session.agent, previous });
    } else {
      const previous = session.model;
      session.model = (body as { model: ModelRef }).model;
      if (previous?.id !== session.model.id || previous.providerID !== session.model.providerID
        || (previous.variant ?? 'default') !== (session.model.variant ?? 'default')) {
        emit('session.model.selected', { sessionID: match[1], model: session.model, previous });
      }
    }
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 404, { name: 'NotFoundError', data: { message: `No route for ${req.method} ${path}` } });
});

server.listen(Number(readFlag('port') ?? 0), readFlag('hostname') ?? '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  log({ started: true, pid: process.pid, port, args, passwordSet: Boolean(password) });
  console.log(`server listening on http://${readFlag('hostname') ?? '127.0.0.1'}:${port}`);
});
