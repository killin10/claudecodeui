import type { OpenCodeClient, PermissionRequest as OpenCodePermissionRequest, FormInfo } from '@opencode/client';

import type { AnyRecord, ProviderPermissionDecision } from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord, readOpenCodeErrorMessage, isOpenCodeNotFoundError } from '@/shared/utils.js';

import { prepareOpenCodeFormAnswer } from './opencode-forms.provider.js';

const PROVIDER = 'opencode';
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

const pendingPrompts = new Map<string, PendingOpenCodePrompt>();
// V2 persists approvals with explicit save resources in its project store.
// This per-chat cache also covers requests without save resources; those
// fallback approvals last only until CloudCLI restarts or evicts the chat.
const rememberedApprovals = new Map<string, RememberedApproval[]>();
const approvalProjects = new Map<string, string>();

/** Settings clears fallback approvals after changing native saved grants so a cached allow cannot undo revocation. */
export function clearOpenCodeRememberedApprovals(projectId: string): void {
  for (const [chat, project] of approvalProjects) {
    if (project !== projectId) continue;
    rememberedApprovals.delete(chat);
    approvalProjects.delete(chat);
  }
}

/** Gateway and regression tests use this mapping only after native rules request approval. */
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
    approvalProjects.delete(oldestKey);
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
    form: request,
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


/** Owns one turn's interactive requests; runtime owns routing and lifecycle, Settings revokes saved grants. */
export class OpenCodePermissionGateway {
  private readonly ids = new Set<string>();
  private readonly promptSessions = new Map<string, string>();
  private readonly forms = new Map<string, FormInfo>();
  private readonly formDirectories = new Map<string, string>();

  constructor(private readonly host: {
    client: OpenCodeClient | null;
    providerSessionId: string | null;
    abortController: AbortController;
    aborted: boolean;
  }, private readonly context: {
    appSessionId: string | null;
    directory: string;
    permissionMode: unknown;
    sessionSummary: unknown;
    sessionId(): string;
    projectId(): string | undefined;
    stopped(): boolean;
    send(message: unknown): void;
    fail(message: string): void;
    notify(event: AnyRecord): void;
  }) {}

  askQuestion(form: FormInfo, directory: string): void {
    this.formDirectories.set(form.id, directory);
    this.handleQuestionAsked(form);
  }

  settleForm(id: string, sessionId: string): void {
    if (this.forms.get(id)?.sessionID === sessionId) pendingPrompts.get(id)?.settle();
  }

  close(): void {
    for (const id of this.ids) pendingPrompts.get(id)?.settle('cancelled');
  }
  private replyToPermission = async (requestId: string, reply: OpenCodePermissionReply) => {
    try {
      await this.host.client!.permission.reply({
        sessionID: this.promptSessions.get(requestId) ?? this.host.providerSessionId!, requestID: requestId, decision: reply,
      }, { signal: this.host.abortController.signal });
    } catch (error) {
      // Already settled by OpenCode itself (its cascade after another reply).
      if (isOpenCodeNotFoundError(error) || this.host.aborted || this.context.stopped()) {
        return;
      }
      this.context.fail(`OpenCode did not accept the permission reply: ${readOpenCodeErrorMessage(error)}`);
    }
  };

  private replyToQuestion = async (requestId: string, decision: ProviderPermissionDecision): Promise<boolean> => {
    try {
      const form = this.forms.get(requestId);
      const requestOptions = {
        signal: this.host.abortController.signal,
        headers: { 'x-opencode-directory': encodeURIComponent(this.formDirectories.get(requestId) ?? this.context.directory) },
      };
      if (decision.allow && form) {
        const labels = readQuestionAnswers(decision.updatedInput, form.fields.map((field) => ({
          question: field.description || field.title || field.key,
        })));
        const answer = prepareOpenCodeFormAnswer(form, decision.updatedInput, labels);
        await this.host.client!.session.form.reply({ sessionID: form.sessionID, formID: requestId, answer }, requestOptions);
      } else {
        await this.host.client!.session.form.cancel({ sessionID: form?.sessionID ?? this.host.providerSessionId!, formID: requestId }, requestOptions);
      }
      return true;
    } catch (error) {
      if (isOpenCodeNotFoundError(error) || this.host.aborted || this.context.stopped()) {
        return true;
      }
      // Validation and transport errors leave the native form open. Keep its
      // identity and answers so the same prompt can be corrected/retried.
      const pending = pendingPrompts.get(requestId);
      if (pending) {
        pending.context = { ...pending.context, validationError: readOpenCodeErrorMessage(error) };
        this.context.send(createNormalizedMessage({
          kind: 'permission_request', requestId, toolName: pending.toolName,
          input: pending.input, context: pending.context, sessionId: this.context.sessionId(), provider: PROVIDER,
        }));
      }
      return false;
    }
  };

  /** Shows a request in the chat and holds it until it is answered or times out. */
  private askChat = (prompt: {
    requestId: string;
    toolName: string;
    input: unknown;
    context: AnyRecord;
    timeoutMs: number;
    onAnswer(decision: ProviderPermissionDecision): void | Promise<boolean>;
    onTimeout(): void;
  }) => {
    let replying = false;
    const pending: PendingOpenCodePrompt = {
      requestId: prompt.requestId,
      // Keyed by the app session id so `chat.subscribe` can find it after a refresh.
      sessionId: this.context.appSessionId ?? this.host.providerSessionId,
      toolName: prompt.toolName,
      input: prompt.input,
      context: prompt.context,
      receivedAt: new Date(),
      timer: undefined,
      answer: async (decision) => {
        if (pendingPrompts.get(prompt.requestId) !== pending || replying) {
          return;
        }
        replying = true;
        try {
          if (await prompt.onAnswer(decision) !== false) pending.settle();
        } finally {
          replying = false;
        }
      },
      settle: (reason) => {
        if (pendingPrompts.get(prompt.requestId) !== pending) {
          return;
        }
        clearTimeout(pending.timer);
        pendingPrompts.delete(prompt.requestId);
        this.ids.delete(prompt.requestId);
        this.context.send(createNormalizedMessage({
          kind: reason ? 'permission_cancelled' : 'permission_resolved',
          requestId: prompt.requestId,
          ...(reason ? { reason } : {}),
          sessionId: this.context.sessionId(),
          provider: PROVIDER,
        }));
      },
    };

    pendingPrompts.set(prompt.requestId, pending);
    this.ids.add(prompt.requestId);
    if (prompt.timeoutMs > 0) {
      pending.timer = setTimeout(() => {
        pending.settle('timeout');
        prompt.onTimeout();
      }, prompt.timeoutMs);
    }

    this.context.send(createNormalizedMessage({
      kind: 'permission_request',
      requestId: prompt.requestId,
      toolName: prompt.toolName,
      input: prompt.input,
      context: prompt.context,
      sessionId: this.context.sessionId(),
      provider: PROVIDER,
    }));
  };

  handlePermissionAsked = (request: OpenCodePermissionRequest) => {
    // A stopping or finished turn asks nobody; its server is about to go.
    if (this.host.aborted || this.context.stopped()) {
      return;
    }
    this.promptSessions.set(request.id, request.sessionID);
    const automaticReply = resolveAutomaticPermissionReply(this.context.permissionMode, request.action)
      ?? (isCoveredByApprovals(rememberedApprovals.get(this.context.sessionId()), request.action, request.resources) ? 'once' : null);
    if (automaticReply) {
      void this.replyToPermission(request.id, automaticReply);
      return;
    }

    this.askChat({
      requestId: request.id,
      toolName: request.action,
      input: { ...request.metadata, patterns: request.resources },
      // `always` is what "Always allow" approves; the chat shows it beside the button.
      context: { patterns: request.resources, always: (request.save ?? request.resources) },
      timeoutMs: TOOL_APPROVAL_TIMEOUT_MS,
      onAnswer: (decision) => {
        const reply = toOpenCodePermissionReply(decision);
        if (reply === 'always') {
          rememberApprovals(this.context.sessionId(), request.action, (request.save ?? request.resources));
          const projectId = this.context.projectId();
          if (projectId && rememberedApprovals.has(this.context.sessionId())) approvalProjects.set(this.context.sessionId(), projectId);
        }
        void this.replyToPermission(request.id, reply);
      },
      onTimeout: () => void this.replyToPermission(request.id, 'reject'),
    });

    this.context.notify({
      provider: PROVIDER,
      sessionId: this.context.sessionId(),
      kind: 'action_required',
      code: 'permission.required',
      meta: { toolName: request.action, sessionName: this.context.sessionSummary },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `opencode:permission:${this.context.sessionId()}:${request.id}`,
    });
  };

  private handleQuestionAsked = (request: FormInfo) => {
    if (this.host.aborted || this.context.stopped()) {
      return;
    }
    // Headless runs cannot supply user answers. Cancel the form explicitly.
    this.forms.set(request.id, request);
    if (this.context.permissionMode === 'bypassPermissions') {
      void this.replyToQuestion(request.id, { allow: false });
      return;
    }

    this.askChat({
      requestId: request.id,
      toolName: 'AskUserQuestion',
      input: toAskUserQuestionInput(request),
      // Retain label-list compatibility while native panels submit typed
      // answers and wait for server acknowledgement before removing the form.
      context: { answerFormat: 'label-lists', waitForResolution: true },
      timeoutMs: QUESTION_TIMEOUT_MS,
      onAnswer: (decision) => this.replyToQuestion(request.id, decision),
      onTimeout: () => void this.replyToQuestion(request.id, { allow: false }),
    });

    this.context.notify({
      provider: PROVIDER,
      sessionId: this.context.sessionId(),
      kind: 'action_required',
      code: 'agent.notification',
      meta: { message: request.fields[0]?.title || 'OpenCode has a question for you', sessionName: this.context.sessionSummary },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `opencode:question:${this.context.sessionId()}:${request.id}`,
    });
  };

}

/** Runtime permission responses reach the gateway for the owning turn. */
export function resolveOpenCodePrompt(requestId: string, decision: ProviderPermissionDecision): void {
  pendingPrompts.get(requestId)?.answer(decision);
}

/**
 * Pending prompts of a session, replayed to a client that subscribes after a
 * refresh. Same shape as the Claude runtime's pending approvals.
 */
export function getPendingOpenCodePrompts(sessionId: string) {
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

/** Runtime routes native replies to the pending UI request. */
export function settleOpenCodePermission(requestId: string): void {
  pendingPrompts.get(requestId)?.settle();
}

/** Runtime abort withdraws all requests for the stopped conversation. */
export function cancelOpenCodePrompts(sessionIds: Array<string | null>): void {
  for (const prompt of pendingPrompts.values()) {
    if (sessionIds.includes(prompt.sessionId)) prompt.settle('cancelled');
  }
}
