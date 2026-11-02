import fsSync from 'node:fs';
import { readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import type {
  OpenCodeClient as OpencodeClient,
  OpenCodeEvent,
  JsonValue,
  SessionMessageInfo,
  PermissionRequest as OpenCodePermissionRequest,
  FormInfo,
  FormAnswer,
} from '@opencode/client';

import {
  normalizeAttachmentDescriptors,
} from '@/shared/image-attachments.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled,
} from '@/modules/notifications/index.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  getOpenCodeDatabasePath,
  readObjectRecord,
} from '@/shared/utils.js';
import type {
  AnyRecord,
  BackgroundTaskSummary,
  ProviderModelsDefinition,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

import { startOpenCodeServer } from './opencode-server.provider.js';
import { OpenCodeEventProjector } from './opencode-events.provider.js';

// The notifications module is still JavaScript, and its defaults (`dedupeKey = null`,
// `sessionId = null`) infer as the only accepted types; these state the shapes
// callers really pass.
const notificationEvent = createNotificationEvent as (event: AnyRecord) => unknown;
const reportRunStopped = notifyRunStopped as (input: AnyRecord) => void;
const reportRunFailed = notifyRunFailed as (input: AnyRecord) => void;

const PROVIDER = 'opencode';

const NOT_INSTALLED_MESSAGE = 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/';


/** Budget for the initial V2 event-stream handshake. */
const SERVER_START_TIMEOUT_MS = 60_000;

/**
 * How long the event stream may take to confirm it is connected. The first
 * request for a project waits while OpenCode opens it (config, plugins, MCP
 * servers), which a project with slow plugins can stretch well past a few
 * seconds, so it gets the same budget as the server start.
 */
const EVENT_STREAM_CONNECT_TIMEOUT_MS = SERVER_START_TIMEOUT_MS;

/**
 * Names, in each turn server's environment, the CloudCLI process that started
 * it, so a later CloudCLI can tell the servers of a process that died without
 * stopping them.
 */
const OWNER_PID_ENV = 'CLOUDCLI_OPENCODE_OWNER_PID';

/** How long stopping a turn waits for OpenCode's session abort before stopping the server anyway. */
const SESSION_ABORT_TIMEOUT_MS = 5_000;

const readTimeoutFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Unanswered permission prompts are rejected after this long (0 waits), the
 * same default the Claude runtime uses, so a run nobody watches does not hold
 * its server forever.
 */
const TOOL_APPROVAL_TIMEOUT_MS = readTimeoutFromEnv('OPENCODE_TOOL_APPROVAL_TIMEOUT_MS', 55_000);

/**
 * Unanswered questions are dismissed after this long (0 waits). Longer than
 * for permissions: a question usually needs thought, not just a yes or no.
 */
const QUESTION_TIMEOUT_MS = readTimeoutFromEnv('OPENCODE_QUESTION_TIMEOUT_MS', 30 * 60_000);

/**
 * Upper bound on how many chats keep their "Always allow" approvals in memory.
 * The least recently approving chat is forgotten first.
 */
const MAX_REMEMBERED_APPROVAL_SESSIONS = 500;

/** How a chat's decision reaches OpenCode's permission API. */
type OpenCodePermissionReply = 'once' | 'always' | 'reject';

type OpenCodeServer = { url: string; close(): void };

/** One running turn, keyed in `activeTurns` by the session it runs for. */
type OpenCodeTurn = {
  key: string;
  /** Ends the event stream and stops a server that is still starting. */
  abortController: AbortController;
  server: OpenCodeServer | null;
  client: OpencodeClient | null;
  providerSessionId: string | null;
  aborted: boolean;
  /** Settles once a requested stop has finished (session aborted, server stopped). */
  abortFinished: Promise<void> | null;
  /** Wakes a turn that is waiting for OpenCode to finish. */
  finish(): void;
  tasks: Map<string, BackgroundTaskSummary>;
};

/** A permission or question the turn is waiting on the chat to answer. */
type PendingOpenCodePrompt = {
  requestId: string;
  /** Session the chat knows the prompt by: the app session id when there is one. */
  sessionId: string | null;
  toolName: string;
  input: unknown;
  context: AnyRecord;
  receivedAt: Date;
  timer: ReturnType<typeof setTimeout> | undefined;
  answer(decision: ProviderPermissionDecision): void;
  /** Drops the prompt from the chat; `reason` marks a withdrawal (timeout, stop). */
  settle(reason?: string): void;
};

/** A rule an "Always allow" approved: OpenCode permission plus one of its `always` patterns. */
type RememberedApproval = {
  permission: string;
  pattern: string;
};

const activeTurns = new Map<string, OpenCodeTurn>();
// A completed foreground turn can retain its server while child sessions run.
const liveTurns = new Set<OpenCodeTurn>();
const pendingPrompts = new Map<string, PendingOpenCodePrompt>();
// "Always allow" is remembered by OpenCode only in its server's memory, and a
// turn's server stops with the turn. The approved patterns are kept here per
// chat instead (in memory, never persisted), so a later turn in the same chat
// is not asked again for what the user already allowed always.
const rememberedApprovals = new Map<string, RememberedApproval[]>();

// ---------------------------------------------------------------------------
// Permission modes and model options
// ---------------------------------------------------------------------------

/**
 * Picks the OpenCode reply a permission request gets without asking the user,
 * or null when the chat has to ask.
 *
 * - bypassPermissions → `once` for everything, like `opencode run --auto`.
 * - acceptEdits       → `once` for file edits; everything else is asked.
 * - plan / default    → asked (plan's own agent already denies edits).
 *
 * Only `ask` rules produce a request at all: what the user's OpenCode config
 * allows never gets here, and what it denies is denied by OpenCode itself.
 *
 * Exported for tests only.
 */
export function resolveAutomaticPermissionReply(
  permissionMode: unknown,
  permission: string,
): OpenCodePermissionReply | null {
  if (permissionMode === 'bypassPermissions') {
    return 'once';
  }

  if (permissionMode === 'acceptEdits' && permission === 'edit') {
    return 'once';
  }

  return null;
}

/**
 * Maps a chat decision onto OpenCode's permission reply. The chat asks for a
 * remembered approval with `rememberEntry`; for OpenCode that is its own
 * `always`, whose patterns come from the request, not from the client. A
 * denial is a plain `reject`, which ends the turn like OpenCode's own Reject.
 *
 * Exported for tests only.
 */
export function toOpenCodePermissionReply(decision: ProviderPermissionDecision): OpenCodePermissionReply {
  if (!decision.allow) {
    return 'reject';
  }

  return decision.rememberEntry ? 'always' : 'once';
}

function resolveOpenCodeEffort(
  model: string | undefined,
  effort: unknown,
  modelsDefinition: ProviderModelsDefinition | null,
): string | undefined {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model);
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Splits a `provider/model` id the way `opencode run --model` does: at the first
 * slash, so model ids that contain slashes themselves stay whole.
 */
function parseOpenCodeModel(model: string | undefined): { providerID: string; id: string } | undefined {
  if (!model) return undefined;
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error('OpenCode model must be provider/model.');
  }
  return { providerID: model.slice(0, separator), id: model.slice(separator + 1) };
}

// ---------------------------------------------------------------------------
// Permission rules and "Always allow" memory
// ---------------------------------------------------------------------------

/**
 * OpenCode's own wildcard matcher (`Wildcard.match` in its core package): `*`
 * matches anything, `?` one character, and a trailing ` *` also matches the
 * bare command, so `git status *` covers `git status`.
 */
function matchesOpenCodeWildcard(input: string, pattern: string): boolean {
  const normalizedInput = input.replaceAll('\\', '/');
  let expression = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  if (expression.endsWith(' .*')) {
    expression = `${expression.slice(0, -3)}( .*)?`;
  }

  return new RegExp(`^${expression}$`, process.platform === 'win32' ? 'si' : 's').test(normalizedInput);
}

/**
 * Whether an earlier "Always allow" in this chat already covers a request:
 * every one of its patterns has to match an approved rule, the same test
 * OpenCode applies to its own approvals.
 *
 * Exported for tests only.
 */
export function isCoveredByApprovals(
  approvals: RememberedApproval[] | undefined,
  permission: string,
  patterns: string[],
): boolean {
  if (!approvals?.length || patterns.length === 0) {
    return false;
  }

  return patterns.every((pattern) => approvals.some((rule) =>
    matchesOpenCodeWildcard(permission, rule.permission) && matchesOpenCodeWildcard(pattern, rule.pattern)));
}

function rememberApprovals(chatKey: string, permission: string, patterns: string[]): void {
  if (patterns.length === 0) {
    return;
  }

  const approvals = rememberedApprovals.get(chatKey) ?? [];
  for (const pattern of patterns) {
    if (!approvals.some((rule) => rule.permission === permission && rule.pattern === pattern)) {
      approvals.push({ permission, pattern });
    }
  }

  // Re-inserting moves the chat to the newest end of the map's order.
  rememberedApprovals.delete(chatKey);
  rememberedApprovals.set(chatKey, approvals);
  while (rememberedApprovals.size > MAX_REMEMBERED_APPROVAL_SESSIONS) {
    const oldestKey = rememberedApprovals.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    rememberedApprovals.delete(oldestKey);
  }
}

// Questions
// ---------------------------------------------------------------------------

/**
 * Shapes an OpenCode question request as the input of the chat's
 * AskUserQuestion panel. `multiple` is OpenCode's name for Claude's
 * `multiSelect`; `custom: false` hides the typed answer.
 */
function toAskUserQuestionInput(request: FormInfo): AnyRecord {
  return {
    questions: request.fields.map((field) => ({
      question: field.description || field.title || field.key,
      header: field.title || request.title,
      ...(field.type === 'external' ? { externalUrl: field.url } : {}),
      options: 'options' in field ? (field.options ?? []).map((option) => ({
        label: option.label ?? String(option.value), description: option.description ?? '',
      })) : field.type === 'boolean' ? [{ label: 'true' }, { label: 'false' }]
        : field.type === 'external' ? [{ label: 'Continue' }] : [],
      multiSelect: field.type === 'multiselect',
      custom: field.type === 'external' ? false : 'custom' in field ? field.custom !== false : true,
    })),
  };
}

/**
 * Reads the answers the chat sent for a question request: one list of labels
 * per question, in question order. Answers keyed by question text (the shape
 * Claude's panel uses) are accepted as one label each.
 *
 * Exported for tests only.
 */
export function readQuestionAnswers(
  updatedInput: unknown,
  questions: Array<{ question: string }>,
): string[][] {
  const answers = readObjectRecord(updatedInput)?.answers;
  const toLabels = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.filter((label): label is string => typeof label === 'string' && label.trim().length > 0);
    }
    return typeof value === 'string' && value.trim() ? [value] : [];
  };

  if (Array.isArray(answers)) {
    return questions.map((_, index) => toLabels(answers[index]));
  }

  const keyedAnswers = readObjectRecord(answers);
  return questions.map((question) => toLabels(keyedAnswers?.[question.question]));
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

function readOpenCodeTokenUsage(sessionId: string | null) {
  const dbPath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(dbPath)) {
    return null;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const columns = db.prepare('PRAGMA table_info(session_v2)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return null;
    }

    const row = db.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session_v2
      WHERE id = ?
    `).get(sessionId) as AnyRecord | undefined;

    if (!row) {
      return null;
    }

    const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
    const outputTokens = Number(row.outputTokens || 0);
    const used = Number(row.inputTokens || 0)
      + outputTokens
      + Number(row.reasoningTokens || 0)
      + Number(row.cacheReadTokens || 0)
      + Number(row.cacheWriteTokens || 0);
    if (used <= 0) {
      return null;
    }

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------
// Server lifetime
// ---------------------------------------------------------------------------

let exitHookInstalled = false;

/**
 * Stops the servers of turns still running when CloudCLI exits. The shutdown
 * handlers end with `process.exit`, which runs this synchronously; the SDK
 * signals its child at once (a process-tree kill on Windows).
 */
function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }

  exitHookInstalled = true;
  process.on('exit', () => {
    for (const turn of liveTurns) {
      turn.abortController.abort();
      turn.server?.close();
    }
  });
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Stops turn servers that a CloudCLI process started and never stopped because
 * it was killed (SIGKILL, the OOM killer) before its exit hook could run. Such a
 * server never exits by itself, unlike the `opencode run` process it replaces.
 *
 * A process is only stopped when its environment names a CloudCLI owner that
 * is gone and its arguments are a turn server's (`serve --hostname=127.0.0.1
 * --port=…`), so commands the agent left running in the background are never
 * touched. The owner pid only means something inside the PID namespace that
 * issued it: a CloudCLI on the host also sees a container's processes in
 * /proc, and their owner pid would look dead from out here, so processes of
 * another (or an unreadable) namespace are skipped. Linux only: the
 * environment is read from /proc, which tests point at a fake tree.
 *
 * Used by the server entrypoint once at startup, through the providers module.
 */
export async function reapOrphanedOpenCodeServers(procRoot = '/proc'): Promise<number> {
  if (process.platform !== 'linux') {
    return 0;
  }

  const ownNamespace = await readlink(path.join(procRoot, 'self', 'ns', 'pid')).catch(() => null);
  if (!ownNamespace) {
    return 0;
  }

  let reaped = 0;
  const entries = await readdir(procRoot).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) {
      continue;
    }

    const pid = Number(entry);
    // Other users' processes are unreadable and skipped.
    const [environ, cmdline, namespace] = await Promise.all([
      readFile(path.join(procRoot, entry, 'environ'), 'utf8').catch(() => ''),
      readFile(path.join(procRoot, entry, 'cmdline'), 'utf8').catch(() => ''),
      readlink(path.join(procRoot, entry, 'ns', 'pid')).catch(() => null),
    ]);
    const owner = environ.split('\0').find((variable) => variable.startsWith(`${OWNER_PID_ENV}=`));
    const ownerPid = Number(owner?.slice(OWNER_PID_ENV.length + 1));
    const args = cmdline.split('\0');
    const isTurnServer = args.includes('serve')
      && args.includes('--hostname=127.0.0.1')
      && args.some((arg) => arg.startsWith('--port='));
    if (
      !isTurnServer
      || namespace !== ownNamespace
      || !Number.isInteger(ownerPid)
      || ownerPid <= 0
      || isProcessAlive(ownerPid)
    ) {
      continue;
    }

    try {
      process.kill(pid, 'SIGTERM');
      reaped += 1;
    } catch {
      // Gone already.
    }
  }

  return reaped;
}

/**
 * Whether a failed start is worth one more try: two servers migrating the
 * shared database at once can make one of them fail with `database is locked`,
 * and another process can take the reserved port before the server binds it.
 */
function isRetryableStartFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY|EADDRINUSE|address already in use/i.test(message);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  const record = readObjectRecord(error);
  const data = readObjectRecord(record?.data);
  if (typeof data?.message === 'string' && data.message) {
    return data.message;
  }
  if (typeof record?.message === 'string' && record.message) {
    return record.message;
  }
  if (typeof record?.name === 'string' && record.name) {
    return record.name;
  }
  return String(error);
}

/** Whether an SDK call failed because OpenCode no longer knows the request (already settled). */
function isNotFoundError(error: unknown): boolean {
  const cause = readObjectRecord(error instanceof Error ? error.cause : undefined);
  return cause?.status === 404 || readObjectRecord(error)?.status === 404
    || (error instanceof Error && error.name === 'NotFoundError');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function resolveAgent(client: OpencodeClient, directory: string, mode: unknown): Promise<string> {
  if (mode === 'plan') return 'plan';
  const entries = await client.config.get({ location: { directory } });
  let agent = 'build';
  for (const entry of entries) {
    if (entry.type === 'document' && entry.info.default_agent) agent = entry.info.default_agent;
  }
  return agent;
}

/** Lets microtasks queued by the caller (the abort handler's terminal `complete`) run first. */
const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

/**
 * Runs one OpenCode turn. Resolves when the turn completed, rejects when it
 * failed; an aborted turn resolves once its stop has finished, so the abort
 * handler's terminal `complete` is the one the chat receives.
 */
async function runOpenCodeTurn(
  command: string,
  options: AnyRecord = {},
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    effort,
    sessionSummary,
    images,
    files,
    permissionMode,
  } = options;
  const appSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null;
  // Callers pass the stable app session id; OpenCode resumes with the
  // provider-native id recorded on the session row.
  const resolvedSessionId = context.resolveProviderSessionId(appSessionId);
  // Older application migrations backfilled pending UUIDs as native ids after
  // a restart. OpenCode's native ids use ses_; such a UUID never reached it.
  const pendingAppPlaceholder = resolvedSessionId === appSessionId
    && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(resolvedSessionId ?? '');
  const resumeSessionId = pendingAppPlaceholder ? null : resolvedSessionId;
  const workingDir: string = cwd || projectPath || process.cwd();
  const userId = writer?.userId ?? null;

  let turnDone!: () => void;
  const turnFinished = new Promise<void>((resolve) => {
    turnDone = resolve;
  });
  const turn: OpenCodeTurn = {
    key: appSessionId ?? resumeSessionId ?? `opencode-${Date.now()}`,
    abortController: new AbortController(),
    server: null,
    client: null,
    providerSessionId: resumeSessionId,
    aborted: false,
    abortFinished: null,
    finish: () => turnDone(),
    tasks: new Map(),
  };
  activeTurns.set(turn.key, turn);
  liveTurns.add(turn);
  installExitHook();

  const turnSessionId = () => appSessionId ?? turn.providerSessionId ?? turn.key;
  // "Always allow" is remembered per chat; direct callers without an app id
  // fall back to the OpenCode session.
  const approvalsKey = () => appSessionId ?? turn.providerSessionId ?? turn.key;
  const send = (message: unknown) => writer.send(message);
  const sentErrors = new Set<string>();
  const sendError = (content: string) => {
    // OpenCode can report one failure more than once (a prompt that fails
    // before it runs is published twice); the chat shows it once.
    if (sentErrors.has(content)) {
      return;
    }
    sentErrors.add(content);
    send(createNormalizedMessage({
      kind: 'error',
      content,
      sessionId: turnSessionId(),
      provider: PROVIDER,
    }));
  };
  const notify = (event: AnyRecord) => notifyUserIfEnabled({ userId, event: notificationEvent(event) });

  const turnPromptIds = new Set<string>();
  const projector = new OpenCodeEventProjector(turnSessionId, send);
  const forms = new Map<string, FormInfo>();
  const formDirectories = new Map<string, string>();
  const ownedSessions = new Set(resumeSessionId ? [resumeSessionId] : []);
  const promptSessions = new Map<string, string>();
  let messageQueue = Promise.resolve();
  let sawBusy = false;
  let turnEnded = false;
  let turnError: string | null = null;
  let rootIdle = false;
  let completeSent = false;
  let backgroundQuietTimer: ReturnType<typeof setTimeout> | undefined;
  let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
  const rootToolMessages = new Set<string>();
  const settledChildren = new Set<string>();
  const childToolIds = new Map<string, string>();
  const childProjectors = new Map<string, OpenCodeEventProjector>();
  const toolProgress = new Map<string, Record<string, JsonValue>>();

  const finishForeground = () => {
    rootIdle = true;
    if (turn.tasks.size === 0) {
      if (completeSent) settleBackground();
      else turnDone();
      return;
    }
    if (!completeSent) {
      send(createCompleteMessage({ provider: PROVIDER, sessionId: turnSessionId(), exitCode: 0 }));
      completeSent = true;
    }
    // Keep the stream and permission gateway alive for detached children.
    // A finite ceiling prevents an orphaned child retaining a server forever.
    backgroundTimer ??= setTimeout(() => failTurn('OpenCode background work exceeded the 30 minute limit.'), 30 * 60_000);
    backgroundTimer.unref();
  };

  const settleBackground = () => {
    if (!rootIdle || turn.tasks.size > 0) return;
    clearTimeout(backgroundQuietTimer);
    // Native child completion can enqueue a follow-up on its parent. Let that
    // wakeup publish, then check process-local activity before closing its server.
    backgroundQuietTimer = setTimeout(() => {
      void turn.client!.session.active({ signal: turn.abortController.signal }).then((active) => {
        if (rootIdle && turn.tasks.size === 0 && !active[turn.providerSessionId!]) turnDone();
      }).catch((error) => { if (!turn.aborted) failTurn(readErrorMessage(error)); });
    }, 250);
  };

  // A resumed child emits no session.created event. Verify its ancestry before
  // routing requests; never accept an unrelated session just because it shares a server.
  const ownsSession = async (sessionID: string): Promise<boolean> => {
    const ancestors = new Set<string>();
    let current: string | undefined = sessionID;
    while (current && !ownedSessions.has(current)) {
      if (ancestors.has(current)) return false;
      ancestors.add(current);
      try {
        const session = await turn.client!.session.get({ sessionID: current }, {
          signal: AbortSignal.any([turn.abortController.signal, AbortSignal.timeout(5000)]),
        });
        current = session.parentID;
      } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
      }
    }
    if (!current) return false;
    for (const ancestor of ancestors) ownedSessions.add(ancestor);
    return true;
  };

  const failTurn = (message: string) => {
    sendError(message);
    turnError ??= message;
    turnDone();
  };

  const registerProviderSession = (providerSessionId: string) => {
    turn.providerSessionId = providerSessionId;
    ownedSessions.add(providerSessionId);
    // Direct callers without an app session id find the turn by the
    // provider-native id from now on.
    if (!appSessionId && turn.key !== providerSessionId) {
      if (activeTurns.get(turn.key) === turn) {
        activeTurns.delete(turn.key);
      }
      turn.key = providerSessionId;
      activeTurns.set(turn.key, turn);
    }

    writer.setSessionId?.(providerSessionId);
    send(createNormalizedMessage({
      kind: 'session_created',
      newSessionId: providerSessionId,
      sessionId: providerSessionId,
      provider: PROVIDER,
    }));
  };

  const replyToPermission = async (requestId: string, reply: OpenCodePermissionReply) => {
    try {
      await turn.client!.permission.reply({
        sessionID: promptSessions.get(requestId) ?? turn.providerSessionId!, requestID: requestId, decision: reply,
      }, { signal: turn.abortController.signal });
    } catch (error) {
      // Already settled by OpenCode itself (its cascade after another reply).
      if (isNotFoundError(error) || turn.aborted || turnEnded) {
        return;
      }
      failTurn(`OpenCode did not accept the permission reply: ${readErrorMessage(error)}`);
    }
  };

  const replyToQuestion = async (requestId: string, answers: string[][] | null) => {
    try {
      const form = forms.get(requestId);
      const requestOptions = {
        signal: turn.abortController.signal,
        headers: { 'x-opencode-directory': encodeURIComponent(formDirectories.get(requestId) ?? workingDir) },
      };
      if (answers && form) {
        const answer: FormAnswer = {};
        form.fields.forEach((field, index) => {
          const selected = answers[index] ?? [];
          if (selected.length === 0) return;
          const values = selected.map((label) => 'options' in field
            ? field.options?.find((option) => (option.label ?? String(option.value)) === label)?.value ?? label
            : label);
          if (field.type === 'external') answer[field.key] = true;
          else if (field.type === 'multiselect') answer[field.key] = values.map(String);
          else if (field.type === 'boolean') answer[field.key] = values[0] === 'true';
          else if (field.type === 'number' || field.type === 'integer') answer[field.key] = Number(values[0]);
          else answer[field.key] = String(values[0] ?? '');
        });
        await turn.client!.session.form.reply({ sessionID: form.sessionID, formID: requestId, answer }, requestOptions);
      } else {
        await turn.client!.session.form.cancel({ sessionID: form?.sessionID ?? turn.providerSessionId!, formID: requestId }, requestOptions);
      }
    } catch (error) {
      if (isNotFoundError(error) || turn.aborted || turnEnded) {
        return;
      }
      failTurn(`OpenCode did not accept the answer: ${readErrorMessage(error)}`);
    }
  };

  /** Shows a request in the chat and holds it until it is answered or times out. */
  const askChat = (prompt: {
    requestId: string;
    toolName: string;
    input: unknown;
    context: AnyRecord;
    timeoutMs: number;
    onAnswer(decision: ProviderPermissionDecision): void;
    onTimeout(): void;
  }) => {
    const pending: PendingOpenCodePrompt = {
      requestId: prompt.requestId,
      // Keyed by the app session id so `chat.subscribe` can find it after a refresh.
      sessionId: appSessionId ?? turn.providerSessionId,
      toolName: prompt.toolName,
      input: prompt.input,
      context: prompt.context,
      receivedAt: new Date(),
      timer: undefined,
      answer: (decision) => {
        if (pendingPrompts.get(prompt.requestId) !== pending) {
          return;
        }
        // Announced on the run stream so the replay buffer and every other
        // tab watching the run drop the prompt as well.
        pending.settle();
        prompt.onAnswer(decision);
      },
      settle: (reason) => {
        if (pendingPrompts.get(prompt.requestId) !== pending) {
          return;
        }
        clearTimeout(pending.timer);
        pendingPrompts.delete(prompt.requestId);
        turnPromptIds.delete(prompt.requestId);
        send(createNormalizedMessage({
          kind: reason ? 'permission_cancelled' : 'permission_resolved',
          requestId: prompt.requestId,
          ...(reason ? { reason } : {}),
          sessionId: turnSessionId(),
          provider: PROVIDER,
        }));
      },
    };

    pendingPrompts.set(prompt.requestId, pending);
    turnPromptIds.add(prompt.requestId);
    if (prompt.timeoutMs > 0) {
      pending.timer = setTimeout(() => {
        pending.settle('timeout');
        prompt.onTimeout();
      }, prompt.timeoutMs);
    }

    send(createNormalizedMessage({
      kind: 'permission_request',
      requestId: prompt.requestId,
      toolName: prompt.toolName,
      input: prompt.input,
      context: prompt.context,
      sessionId: turnSessionId(),
      provider: PROVIDER,
    }));
  };

  const handlePermissionAsked = (request: OpenCodePermissionRequest) => {
    // A stopping or finished turn asks nobody; its server is about to go.
    if (turn.aborted || turnEnded) {
      return;
    }
    promptSessions.set(request.id, request.sessionID);
    const automaticReply = resolveAutomaticPermissionReply(permissionMode, request.action)
      ?? (isCoveredByApprovals(rememberedApprovals.get(approvalsKey()), request.action, request.resources) ? 'once' : null);
    if (automaticReply) {
      void replyToPermission(request.id, automaticReply);
      return;
    }

    askChat({
      requestId: request.id,
      toolName: request.action,
      input: { ...request.metadata, patterns: request.resources },
      // `always` is what "Always allow" approves; the chat shows it beside the button.
      context: { patterns: request.resources, always: (request.save ?? request.resources) },
      timeoutMs: TOOL_APPROVAL_TIMEOUT_MS,
      onAnswer: (decision) => {
        const reply = toOpenCodePermissionReply(decision);
        if (reply === 'always') {
          rememberApprovals(approvalsKey(), request.action, (request.save ?? request.resources));
        }
        void replyToPermission(request.id, reply);
      },
      onTimeout: () => void replyToPermission(request.id, 'reject'),
    });

    notify({
      provider: PROVIDER,
      sessionId: turnSessionId(),
      kind: 'action_required',
      code: 'permission.required',
      meta: { toolName: request.action, sessionName: sessionSummary },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `opencode:permission:${turnSessionId()}:${request.id}`,
    });
  };

  const handleQuestionAsked = (request: FormInfo) => {
    if (turn.aborted || turnEnded) {
      return;
    }
    // Headless runs cannot supply user answers. Cancel the form explicitly.
    forms.set(request.id, request);
    if (permissionMode === 'bypassPermissions') {
      void replyToQuestion(request.id, null);
      return;
    }

    askChat({
      requestId: request.id,
      toolName: 'AskUserQuestion',
      input: toAskUserQuestionInput(request),
      // Tells the panel to answer with one label list per question and to
      // offer Dismiss, which rejects the question in OpenCode.
      context: { answerFormat: 'label-lists' },
      timeoutMs: QUESTION_TIMEOUT_MS,
      onAnswer: (decision) => {
        void replyToQuestion(
          request.id,
          decision.allow ? readQuestionAnswers(decision.updatedInput, request.fields.map((field) => ({ question: field.description || field.title || field.key }))) : null,
        );
      },
      onTimeout: () => void replyToQuestion(request.id, null),
    });

    notify({
      provider: PROVIDER,
      sessionId: turnSessionId(),
      kind: 'action_required',
      code: 'agent.notification',
      meta: { message: request.fields[0]?.title || 'OpenCode has a question for you', sessionName: sessionSummary },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `opencode:question:${turnSessionId()}:${request.id}`,
    });
  };

  const applyToolProgress = (message: SessionMessageInfo) => {
    if (message.type !== 'assistant') return;
    for (const part of message.content) {
      if (part.type !== 'tool') continue;
      const key = `${message.id}:${part.id}`;
      if (part.state.status === 'running') {
        part.state.metadata = { ...part.state.metadata, ...toolProgress.get(key) };
      } else {
        toolProgress.delete(key);
      }
    }
  };

  const trackSpawnedChildren = (message: SessionMessageInfo, messageID: string, nativeSessionId: string) => {
    if (message.type !== 'assistant' || nativeSessionId !== turn.providerSessionId) return;
    for (const part of message.content) {
      if (part.type !== 'tool' || (part.name !== 'subagent' && part.name !== 'task')) continue;
      rootToolMessages.add(messageID);
      const metadata = 'metadata' in part.state ? part.state.metadata : undefined;
      const childID = metadata?.sessionID;
      if (metadata?.status !== 'running' || typeof childID !== 'string' || settledChildren.has(childID)) continue;
      ownedSessions.add(childID);
      childToolIds.set(childID, part.id);
      turn.tasks.set(childID, {
        taskId: childID, toolUseId: part.id, taskType: 'subagent',
        description: String((part.state.input as AnyRecord)?.description ?? 'OpenCode subagent'),
        startedAt: message.time.created,
      });
    }
  };

  // Serialize message reads so text, tools and the final completion stay ordered.
  const forwardMessage = (
    messageID: string,
    progress?: { id: string; metadata: Record<string, JsonValue> },
    nativeSessionId = turn.providerSessionId!,
    parentToolUseId?: string,
  ) => {
    if (progress) {
      const key = `${messageID}:${progress.id}`;
      toolProgress.set(key, { ...toolProgress.get(key), ...progress.metadata });
    }
    messageQueue = messageQueue.then(async () => {
      const message = await turn.client!.session.message.get({
        sessionID: nativeSessionId, messageID,
      }, { signal: turn.abortController.signal });
      applyToolProgress(message);
      trackSpawnedChildren(message, messageID, nativeSessionId);
      for (const normalized of context.normalizeMessage({ type: 'session.message', message }, turnSessionId())) {
        projector.publish(parentToolUseId ? { ...normalized, parentToolUseId } : normalized);
      }
    }).catch((error) => {
      if (!turn.aborted) failTurn(`Cannot read OpenCode message: ${readErrorMessage(error)}`);
    });
  };

  const handleChildEvent = async (event: OpenCodeEvent) => {
    const data = event.data as AnyRecord;
    await messageQueue;
    const parentToolUseId = childToolIds.get(data.sessionID);
    if (parentToolUseId) {
      let childProjector = childProjectors.get(data.sessionID);
      if (!childProjector) {
        childProjector = new OpenCodeEventProjector(turnSessionId, (message) => send({ ...message, parentToolUseId }));
        childProjectors.set(data.sessionID, childProjector);
      }
      if (childProjector.handle(event)) return;
      switch (event.type) {
        case 'session.text.ended':
        case 'session.reasoning.ended':
        case 'session.tool.called':
        case 'session.tool.success':
        case 'session.tool.failed':
          forwardMessage(event.data.assistantMessageID, undefined, data.sessionID, parentToolUseId);
          break;
        case 'session.tool.progress':
          forwardMessage(event.data.assistantMessageID, event.data, data.sessionID, parentToolUseId);
          break;
      }
    }
    if (event.type === 'session.execution.started') {
      settledChildren.delete(data.sessionID);
      const child = await turn.client!.session.get({ sessionID: data.sessionID }, { signal: turn.abortController.signal });
      if (!turn.tasks.has(data.sessionID)) turn.tasks.set(data.sessionID, {
        taskId: data.sessionID, toolUseId: data.sessionID, taskType: 'subagent',
        description: child.title || 'OpenCode subagent', startedAt: event.created, nested: true,
      });
    }
    if (event.type === 'session.execution.succeeded' || event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted') {
      settledChildren.add(data.sessionID);
      turn.tasks.delete(data.sessionID);
      settleBackground();
    }
    for (const messageID of rootToolMessages) forwardMessage(messageID);
    return;
  };

  const handleRootEvent = async (event: OpenCodeEvent) => {
    const data = event.data as AnyRecord;
    switch (event.type) {
      case 'permission.replied':
        pendingPrompts.get(event.data.requestID)?.settle();
        return;
      case 'session.tool.progress':
        forwardMessage(event.data.assistantMessageID, event.data);
        return;
      case 'session.text.ended':
      case 'session.reasoning.ended':
      case 'session.tool.called':
      case 'session.tool.success':
      case 'session.tool.failed':
      case 'session.step.ended':
        if (data.sessionID === turn.providerSessionId) forwardMessage(event.data.assistantMessageID);
        return;
      case 'session.execution.failed':
        if (data.sessionID === turn.providerSessionId) failTurn(event.data.error.message);
        return;
      case 'session.execution.started':
        sawBusy = true;
        rootIdle = false;
        return;
      case 'session.execution.succeeded':
        await messageQueue;
        if (data.sessionID === turn.providerSessionId) finishForeground();
        return;
      case 'session.execution.interrupted':
        if (data.sessionID === turn.providerSessionId) failTurn(`OpenCode execution interrupted: ${event.data.reason}`);
        return;
      case 'session.idle':
        if (data.sessionID === turn.providerSessionId && sawBusy) finishForeground();
        return;
      case 'session.status':
        if (data.sessionID !== turn.providerSessionId) return;
        if (event.data.status.type === 'busy') sawBusy = true;
        if (event.data.status.type === 'idle' && sawBusy) finishForeground();
        return;
      default:
        return;
    }
  };

  const handleEvent = async (event: OpenCodeEvent) => {
    if (turnEnded || turn.aborted) return;
    if (event.type === 'session.created') {
      if (event.data.parentID && await ownsSession(event.data.parentID)) ownedSessions.add(event.data.sessionID);
      return;
    }
    if (event.type === 'form.created') {
      const form = event.data.form;
      const directory = event.location?.directory;
      const belongs = form.sessionID === 'global'
        ? directory && path.resolve(directory) === path.resolve(workingDir) && form.metadata?.kind === 'mcp-elicitation'
        : await ownsSession(form.sessionID);
      if (belongs) {
        formDirectories.set(form.id, directory ?? workingDir);
        handleQuestionAsked(form);
      }
      return;
    }
    if (event.type === 'form.replied' || event.type === 'form.cancelled') {
      if (forms.get(event.data.id)?.sessionID === event.data.sessionID) pendingPrompts.get(event.data.id)?.settle();
      return;
    }
    const data = event.data as AnyRecord;
    if (event.type === 'permission.asked' && await ownsSession(event.data.sessionID)) {
      handlePermissionAsked(event.data);
      return;
    }
    if (!ownedSessions.has(data.sessionID) && typeof data.sessionID === 'string') {
      if (!await ownsSession(data.sessionID)) return;
    }
    if (!ownedSessions.has(data.sessionID) || turnEnded) return;
    if (event.type === 'permission.replied') pendingPrompts.get(event.data.requestID)?.settle();
    if (data.sessionID !== turn.providerSessionId) {
      await handleChildEvent(event);
      return;
    }
    if (data.sessionID === turn.providerSessionId && projector.handle(event)) return;
    await handleRootEvent(event);
  };

  let connected!: () => void;
  const eventStreamConnected = new Promise<void>((resolve) => {
    connected = resolve;
  });
  let eventLoop: Promise<void> = Promise.resolve();
  let completedNormally = false;

  try {
    const hasAttachments =
      normalizeAttachmentDescriptors(images).length > 0
      || normalizeAttachmentDescriptors(files).length > 0;
    const promptText = typeof command === 'string' ? command.trim() : '';
    if (!promptText && !hasAttachments) {
      throw new Error('OpenCode needs a message to run.');
    }
    const nativeFiles = [...normalizeAttachmentDescriptors(images), ...normalizeAttachmentDescriptors(files)]
      .map((file) => ({
        uri: pathToFileURL(path.resolve(workingDir, file.path)).href,
        ...(file.name ? { name: file.name } : {}),
      }));

    const resolvedModel = await context.resolveResumeModel(appSessionId ?? undefined, model);
    let effortModels: ProviderModelsDefinition | null = null;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[OpenCode] Unable to load provider models for effort validation:', error);
    }
    const variant = resolveOpenCodeEffort(resolvedModel, effort, effortModels);

    if (turn.aborted) {
      throw new Error('aborted');
    }
    let started: Awaited<ReturnType<typeof startOpenCodeServer>>;
    try {
      started = await startOpenCodeServer(turn.abortController.signal);
    } catch (error) {
      if (turn.aborted || !isRetryableStartFailure(error)) {
        throw error;
      }
      started = await startOpenCodeServer(turn.abortController.signal);
    }
    turn.server = started.server;
    if (turn.aborted) {
      throw new Error('aborted');
    }

    const client = started.client;
    turn.client = client;
    let streamError: unknown = null;
    const stream = client.event.subscribe({ signal: turn.abortController.signal });
    eventLoop = (async () => {
      try {
        for await (const event of stream) {
          if (event.type === 'server.connected') {
            connected();
            continue;
          }
          try {
            await handleEvent(event);
          } catch (error) {
            console.error('[OpenCode] Failed to handle an event:', event.type, readErrorMessage(error));
            if (!turn.aborted) failTurn(`Cannot handle OpenCode event ${event.type}: ${readErrorMessage(error)}`);
          }
        }
      } catch (error) {
        streamError ??= error;
      }
      if (!turn.aborted && !turnEnded) {
        failTurn(streamError
          ? `Lost the connection to the OpenCode server: ${readErrorMessage(streamError)}`
          : 'The OpenCode server stopped unexpectedly.');
      }
    })();

    await Promise.race([
      withTimeout(eventStreamConnected, EVENT_STREAM_CONNECT_TIMEOUT_MS, 'The OpenCode event stream did not connect.'),
      turnFinished.then(() => {
        throw new Error(turnError ?? 'The OpenCode event stream ended before it connected.');
      }),
    ]);

    const agent = await resolveAgent(client, workingDir, permissionMode);
    const modelRef = parseOpenCodeModel(resolvedModel);
    const selectedModel = modelRef ? { ...modelRef, ...(variant ? { variant } : {}) } : undefined;
    const requestOptions = { signal: turn.abortController.signal };
    if (turn.providerSessionId) {
      const existing = await client.session.get({ sessionID: turn.providerSessionId }, requestOptions);
      // Preserve a native custom agent on ordinary resume. Leaving a plan entered
      // through CloudCLI restores its previous agent.
      const previousAgent = existing.metadata?.cloudcliPreviousAgent;
      const nextAgent = permissionMode === 'plan' ? 'plan'
        : existing.agent === 'plan' && typeof previousAgent === 'string' ? previousAgent : existing.agent ?? agent;
      if (nextAgent !== existing.agent) {
        const metadata = { ...existing.metadata, cloudcliPreviousAgent: nextAgent === 'plan' ? existing.agent ?? agent : null };
        await client.session.update({ sessionID: turn.providerSessionId, metadata }, requestOptions);
        await client.session.switchAgent({ sessionID: turn.providerSessionId, agent: nextAgent }, requestOptions);
      }
      if (selectedModel) {
        await client.session.switchModel({ sessionID: turn.providerSessionId, model: selectedModel }, requestOptions);
      }
    } else {
      const metadata = {
        ...(appSessionId ? { cloudcliSessionId: appSessionId } : {}),
        ...(permissionMode === 'plan' ? {
          cloudcliPreviousAgent: await resolveAgent(client, workingDir, undefined),
        } : {}),
      };
      const created = await client.session.create({
        location: { directory: workingDir }, agent, model: selectedModel,
        metadata,
      }, requestOptions);
      registerProviderSession(created.id);
    }
    if (turn.aborted) throw new Error('aborted');
    await client.session.prompt({
      sessionID: turn.providerSessionId!, text: promptText,
      ...(nativeFiles.length ? { files: nativeFiles } : {}),
    }, requestOptions);

    await turnFinished;
    await messageQueue;
    completedNormally = !turnError;
  } catch (error) {
    if (!turn.aborted) {
      let message = readErrorMessage(error);
      if (!turn.server && !(await context.isProviderInstalled())) {
        message = NOT_INSTALLED_MESSAGE;
      }
      sendError(message);
      turnError ??= message;
    }
  } finally {
    turnEnded = true;
    if (!turn.aborted && turnError && turn.tasks.size > 0) await interruptTurnWork(turn);
    clearTimeout(backgroundTimer);
    clearTimeout(backgroundQuietTimer);
    liveTurns.delete(turn);
    // Whatever is still open was asked of a turn that has ended.
    for (const requestId of Array.from(turnPromptIds)) {
      pendingPrompts.get(requestId)?.settle('cancelled');
    }

    if (turn.aborted) {
      await turn.abortFinished;
    }
    connected();
    turn.abortController.abort();
    turn.server?.close();
    await eventLoop;
    for (const requestId of Array.from(turnPromptIds)) {
      pendingPrompts.get(requestId)?.settle('cancelled');
    }
    if (activeTurns.get(turn.key) === turn) {
      activeTurns.delete(turn.key);
    }
  }

  const finalSessionId = turnSessionId();
  if (turn.aborted) {
    // The abort handler sends the terminal `complete` (aborted: true) on this
    // turn's behalf. Settling only after the stop has finished — including a
    // stop that landed while the stream was draining — keeps the chat's
    // safety-net `complete` from arriving first.
    await turn.abortFinished;
    await nextMacrotask();
    return;
  }

  // OpenCode's own database is keyed by the provider-native id.
  const tokenBudget = readOpenCodeTokenUsage(turn.providerSessionId);
  if (tokenBudget) {
    send(createNormalizedMessage({
      kind: 'status',
      text: 'token_budget',
      tokenBudget,
      sessionId: finalSessionId,
      provider: PROVIDER,
    }));
  }

  if (!completeSent) send(createCompleteMessage({ provider: PROVIDER, sessionId: finalSessionId, exitCode: completedNormally ? 0 : 1 }));

  if (completedNormally) {
    reportRunStopped({
      userId,
      provider: PROVIDER,
      sessionId: finalSessionId,
      sessionName: sessionSummary,
      stopReason: 'completed',
    });
    return;
  }

  reportRunFailed({
    userId,
    provider: PROVIDER,
    sessionId: finalSessionId,
    sessionName: sessionSummary,
    error: turnError ?? 'OpenCode run failed',
  });
  throw new Error(turnError ?? 'OpenCode run failed');
}

/**
 * Stops the turn running for a session: withdraws its open prompts, aborts the
 * OpenCode session so a running tool command ends too, then stops the server.
 * The caller sends the terminal `complete` (aborted: true) once this returns.
 */
async function interruptTurnWork(turn: OpenCodeTurn): Promise<void> {
  if (!turn.client) return;
  const ids = new Set([...(turn.providerSessionId ? [turn.providerSessionId] : []), ...turn.tasks.keys()]);
  await Promise.all(Array.from(ids, async (sessionID) => {
    try {
      await turn.client!.session.interrupt({ sessionID }, { signal: AbortSignal.timeout(SESSION_ABORT_TIMEOUT_MS) });
    } catch (error) {
      console.warn(`[OpenCode] Failed to interrupt ${sessionID}; stopping its server:`, error);
    }
  }));
}

async function abortOpenCodeSession(sessionId: string): Promise<boolean> {
  const turn = activeTurns.get(sessionId);
  if (!turn) {
    return false;
  }

  // A second stop (Stop pressed twice, Esc twice) waits for the first one, so
  // the run is reported stopped only once the turn really has been.
  if (turn.aborted) {
    await turn.abortFinished;
    return true;
  }

  // Flagged synchronously so the turn emits no `complete` of its own.
  turn.aborted = true;
  turn.abortFinished = (async () => {
    for (const prompt of Array.from(pendingPrompts.values())) {
      if (prompt.sessionId === sessionId || prompt.sessionId === turn.providerSessionId) {
        prompt.settle('cancelled');
      }
    }

    await interruptTurnWork(turn);

    turn.abortController.abort();
    turn.server?.close();
  })();
  turn.finish();

  await turn.abortFinished;
  return true;
}

/**
 * Applies the chat's answer to a pending OpenCode permission or question.
 * Called for every provider's requests, so unknown ids are ignored.
 */
function resolveOpenCodePrompt(requestId: string, decision: ProviderPermissionDecision): void {
  pendingPrompts.get(requestId)?.answer(decision);
}

/**
 * Pending prompts of a session, replayed to a client that subscribes after a
 * refresh. Same shape as the Claude runtime's pending approvals.
 */
function getPendingOpenCodePrompts(sessionId: string) {
  return Array.from(pendingPrompts.values())
    .filter((prompt) => prompt.sessionId === sessionId)
    .map((prompt) => ({
      requestId: prompt.requestId,
      toolName: prompt.toolName,
      input: prompt.input,
      context: prompt.context,
      sessionId,
      receivedAt: prompt.receivedAt,
    }));
}

/**
 * Whether a turn is running for a session. Used by the OpenCode sessions
 * provider, which treats subagents of a running turn as still in progress.
 */
export function isOpenCodeSessionActive(sessionId: string): boolean {
  return Array.from(liveTurns).some((turn) => turn.key === sessionId || turn.tasks.has(sessionId));
}

/**
 * The OpenCode runtime facet. Used by the OpenCode provider wrapper, through
 * which providerRuntimeService runs chat turns, scheduled messages and
 * /api/agent runs, and routes the chat's permission answers.
 */
export const opencodeRuntime = {
  run: runOpenCodeTurn,
  abort: abortOpenCodeSession,
  listBackgroundWork: () => Array.from(liveTurns)
    .filter((turn) => turn.tasks.size > 0)
    .map((turn) => ({ sessionId: turn.key, tasks: Array.from(turn.tasks.values()) })),
  async stopBackgroundTask(sessionId: string, taskId: string): Promise<boolean> {
    const turn = Array.from(liveTurns).find((candidate) => candidate.key === sessionId && candidate.tasks.has(taskId));
    if (!turn?.client) return false;
    await turn.client.session.interrupt({ sessionID: taskId }, { signal: AbortSignal.timeout(SESSION_ABORT_TIMEOUT_MS) });
    // The terminal event removes the task only once native cleanup finishes.
    return true;
  },
  permissions: {
    resolve: resolveOpenCodePrompt,
    listPending: getPendingOpenCodePrompts,
  },
};
