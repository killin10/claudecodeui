import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { isSessionNotFoundError } from '@opencode/client';

import { readOpenCodeUsage } from '@/modules/providers/list/opencode/opencode-usage.provider.js';
import { OpenCodeForkProvider } from '@/modules/providers/list/opencode/opencode-fork.provider.js';
import { isOpenCodeSessionActive } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { startOpenCodeServer } from '@/modules/providers/list/opencode/opencode-server.provider.js';
import { normalizeOpenCodeTool } from '@/modules/providers/list/opencode/opencode-tools.provider.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
  SubagentActivity,
  SubagentInfo,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  getOpenCodeDatabasePath,
  normalizeProviderTimestamp,
  readObjectRecord,
  readJsonRecord,
  readOptionalString,
  sliceTailPage,
  truncateSubagentActivity,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

const PROVIDER = 'opencode';

/** OpenCode's tool for spawning a subagent; it runs in a child session of the caller. */
const SUBAGENT_TOOL_NAME = 'subagent';

/** Upper bound on how much of a subagent's timeline is sent to the client, as for Claude and Codex. */
const MAX_TRANSMITTED_SUBAGENT_ACTIVITIES = 200;

type OpenCodeHistoryRow = {
  message_id: string;
  message_time_created: number | null;
  message_data: string | null;
  part_id: string | null;
  part_time_created: number | null;
  part_data: string | null;
};

/** Projects V2 message content onto the display rows shared by live and history rendering. */
function messageRows(message: AnyRecord): OpenCodeHistoryRow[] {
  const created = message.time?.created ?? 0;
  const messageInfo = JSON.stringify({ role: message.type, error: message.error });
  const base = { message_id: message.id, message_time_created: created, message_data: messageInfo };
  if (message.type === 'idle') {
    return message.outcome === 'failed' && message.error
      ? [{ ...base, message_data: JSON.stringify({ role: 'assistant', error: message.error }), part_id: null, part_time_created: created, part_data: null }]
      : [];
  }
  if (message.type === 'user') {
    return [{ ...base, part_id: '0', part_time_created: created, part_data: JSON.stringify({ type: 'text', text: message.text, attachments: message.files }) }];
  }
  if (message.type !== 'assistant') {
    return [{ ...base, part_id: '0', part_time_created: created, part_data: JSON.stringify(message) }];
  }
  const ordinals = { text: 0, reasoning: 0 };
  const rows = (message.content ?? []).map((part: AnyRecord, index: number) => {
    const state = part.state ?? {};
    const output = state.status !== 'error' && Array.isArray(state.content)
      ? state.content.map((item: AnyRecord) => item.type === 'text' ? item.text : item.uri ?? '').join('\n')
      : undefined;
    const normalizedPart = part.type === 'tool'
      ? { ...part, callID: part.id, ...normalizeOpenCodeTool(part.name, {
        ...state, output, errorType: state.error?.type, error: state.error?.message ?? state.error,
      }) }
      : part;
    return {
      ...base, part_id: part.type === 'text' || part.type === 'reasoning'
        ? `${part.type}_${ordinals[part.type as 'text' | 'reasoning']++}` : String(index), part_time_created: created,
      part_data: JSON.stringify(normalizedPart),
    };
  });
  if (rows.length === 0 && message.error) {
    rows.push({ ...base, part_id: null, part_time_created: created, part_data: null });
  }
  if (message.time?.completed) {
    rows.push({ ...base, part_id: 'end', part_time_created: created, part_data: JSON.stringify({ type: 'step-finish' }) });
  }
  return rows;
}

function nativeAttachments(value: unknown): { images: AnyRecord[]; files: AnyRecord[] } {
  const result: { images: AnyRecord[]; files: AnyRecord[] } = { images: [], files: [] };
  for (const item of Array.isArray(value) ? value : []) {
    const attachment = readObjectRecord(item);
    if (!attachment || typeof attachment.mime !== 'string' || typeof attachment.data !== 'string') continue;
    const descriptor: AnyRecord = {
      name: attachment.name,
      mimeType: attachment.mime,
      data: `data:${attachment.mime};base64,${attachment.data}`,
    };
    const uri = attachment.source?.type === 'uri' ? attachment.source.uri : undefined;
    if (typeof uri === 'string' && uri.startsWith('file:')) descriptor.path = fileURLToPath(uri);
    (attachment.mime.startsWith('image/') ? result.images : result.files).push(descriptor);
  }
  return result;
}

function normalizeSpecialMessage(part: AnyRecord, base: Pick<NormalizedMessage, 'id' | 'sessionId' | 'timestamp' | 'provider'>): NormalizedMessage | null {
  switch (part.type) {
    case 'compaction': {
      const phase = part.status === 'running' ? 'running' : part.status === 'failed' ? 'failed' : 'done';
      const error = readEventError(part.error);
      return createNormalizedMessage({
        ...base, kind: 'text', role: 'assistant',
        content: phase === 'running' ? 'Compacting conversation…'
          : phase === 'failed' ? `Compaction failed: ${error ?? 'Unknown error'}` : part.summary || 'Conversation compacted',
        compact: { phase, trigger: part.reason, ...(error ? { error } : {}) },
      });
    }
    case 'shell':
      return createNormalizedMessage({
        ...base, kind: 'tool_use', toolName: 'Bash', toolId: part.shellID,
        toolInput: { command: part.command },
        ...(part.status !== 'running' ? { toolResult: {
          content: part.output?.output ?? '', isError: part.status !== 'exited' || part.exit !== 0,
        } } : {}),
      });
    case 'skill':
      return createNormalizedMessage({ ...base, kind: 'text', role: 'assistant', content: `Skill: ${part.name}\n${part.text ?? ''}` });
    case 'system':
    case 'synthetic':
      return createNormalizedMessage({ ...base, kind: 'text', role: 'assistant', content: part.text ?? '' });
    case 'agent-switched':
      return createNormalizedMessage({ ...base, kind: 'text', role: 'assistant', content: `Agent: ${part.agent}` });
    case 'model-switched':
      return createNormalizedMessage({ ...base, kind: 'text', role: 'assistant', content: `Model: ${part.model?.providerID}/${part.model?.id}` });
    case 'location-switched':
      return createNormalizedMessage({ ...base, kind: 'text', role: 'assistant', content: `Directory: ${part.location?.directory ?? ''}` });
    default:
      return null;
  }
}

function readHistoryRows(db: Database.Database, sessionId: string): OpenCodeHistoryRow[] {
  const rows = db.prepare(
    'SELECT id, type, data FROM session_message WHERE session_id = ? ORDER BY seq',
  ).all(sessionId) as Array<{ id: string; type: string; data: string }>;
  // Execution failures may repeat the last assistant error in an idle record.
  // Deduplicate only within one turn; the same error on a later turn must remain visible.
  const turnErrors = new Set<string>();
  return rows.flatMap((row) => {
    const message = { ...JSON.parse(row.data), id: row.id, type: row.type };
    if (row.type === 'user') turnErrors.clear();
    const error = message.error ? readEventError(message.error) ?? formatToolContent(message.error) : undefined;
    if (row.type === 'idle' && error && turnErrors.has(error)) delete message.error;
    if (row.type === 'assistant' && error) turnErrors.add(error);
    if (row.type === 'idle') turnErrors.clear();
    return messageRows(message);
  });
}

const openOpenCodeDatabase = (): Database.Database | null => {
  const dbPath = getOpenCodeDatabasePath();
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }

  return new Database(dbPath, { readonly: true, fileMustExist: true });
};

const formatToolContent = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const extractText = (value: unknown): string => {
  if (typeof value === 'string') {
    return unwrapJsonStringLiteral(value);
  }

  const record = readObjectRecord(value);
  const text = readOptionalString(record?.text)
    ?? readOptionalString(record?.content)
    ?? '';
  return unwrapJsonStringLiteral(text);
};

// Error events carry an object (`{ name, data }`), not a string.
const readEventError = (value: unknown): string | undefined => {
  const record = readObjectRecord(value);
  if (!record) {
    return readOptionalString(value);
  }

  const data = readObjectRecord(record.data);
  const message = readOptionalString(data?.message) ?? readOptionalString(record.message);
  if (message) {
    return message;
  }

  const name = readOptionalString(record.name);
  const providerId = readOptionalString(data?.providerID) ?? readOptionalString(record.providerID);
  const modelId = readOptionalString(data?.modelID) ?? readOptionalString(record.modelID);
  if (providerId && modelId) {
    return `${name ?? 'Error'}: ${providerId}/${modelId}`;
  }

  const details = data ? JSON.stringify(data).slice(0, 200) : '';
  return [name, details].filter(Boolean).join(': ') || undefined;
};

/** OpenCode's ask-the-user tool. */
const QUESTION_TOOL_NAME = 'question';

/**
 * Rewrites a `question` call onto the AskUserQuestion card the chat already
 * renders for Claude's and Codex's questions: OpenCode's `multiple` becomes
 * `multiSelect`, and the labels the user picked, which OpenCode keeps in
 * `metadata.answers` as one list per question, are folded into the input
 * keyed by question text, the shape the card reads.
 */
const toAskUserQuestionCall = (toolMessage: NormalizedMessage, toolState: AnyRecord): void => {
  const input = readObjectRecord(toolState.input) ?? readObjectRecord(toolMessage.toolInput);
  if (!input || !Array.isArray(input.questions)) {
    return;
  }

  const answerLists = readObjectRecord(toolState.metadata)?.answers;
  const answers: Record<string, string> = {};
  const questions = input.questions.map((entry: unknown, index: number) => {
    const question = readObjectRecord(entry);
    if (!question) {
      return entry;
    }

    const text = readOptionalString(question.question);
    const picked = Array.isArray(answerLists) && Array.isArray(answerLists[index])
      ? (answerLists[index] as unknown[]).filter((label): label is string => typeof label === 'string' && label.trim().length > 0)
      : [];
    if (text && picked.length > 0) {
      answers[text] = picked.join(', ');
    }

    const { multiple, ...rest } = question;
    return { ...rest, multiSelect: multiple === true };
  });

  toolMessage.toolName = 'AskUserQuestion';
  toolMessage.toolInput = Object.keys(answers).length > 0
    ? { ...input, questions, answers }
    : { ...input, questions };
};

/**
 * Whether an assistant message's error only records that its turn was stopped.
 * Stopping a turn aborts the OpenCode session, which stores this error on the
 * message it interrupted; the live chat never shows it as a failure, so the
 * history does not either.
 */
const isStoppedTurnError = (error: unknown): boolean =>
  readOptionalString(readObjectRecord(error)?.name) === 'MessageAbortedError';

const readToolResult = (state: AnyRecord): SubagentActivity['toolResult'] => {
  const status = readOptionalString(state.status);
  if (status !== 'completed' && status !== 'error') {
    return null;
  }

  return {
    content: formatToolContent(state.output ?? state.error),
    isError: status === 'error',
    ...(state.toolUseResult ? { toolUseResult: state.toolUseResult } : {}),
  };
};

/**
 * Flattens the child session a `task` call spawned into the shared subagent
 * timeline. OpenCode keeps it in the same database as the parent.
 */
const readOpenCodeSubagentActivity = (
  db: Database.Database,
  childSessionId: string,
): SubagentActivity[] => {
  const rows = readHistoryRows(db, childSessionId).filter((row) => readJsonRecord(row.message_data)?.role === 'assistant');

  const activity: SubagentActivity[] = [];
  for (const row of rows) {
    const partData = readJsonRecord(row.part_data) ?? {};
    const timestamp = normalizeProviderTimestamp(row.part_time_created);
    const partType = readOptionalString(partData.type);

    if (partType === 'tool') {
      const state = readObjectRecord(partData.state) ?? {};
      activity.push({
        kind: 'tool',
        toolId: readOptionalString(partData.callID) ?? readOptionalString(partData.id),
        toolName: readOptionalString(partData.tool) ?? 'Tool',
        toolInput: state.input ?? {},
        toolResult: readToolResult(state),
        timestamp,
      });
      continue;
    }

    if (partType === 'text' || partType === 'reasoning') {
      const content = extractText(partData);
      if (content.trim()) {
        activity.push({ kind: partType === 'text' ? 'text' : 'thinking', content, timestamp });
      }
    }
  }

  return activity;
};

// The task tool wraps the subagent's answer as `<task …><task_result>…</task_result></task>`.
const TASK_OUTPUT_PATTERN = /<task_(result|error)>\n?([\s\S]*?)\n?<\/task_\1>/;

const unwrapTaskOutput = (content: string): string => {
  const match = TASK_OUTPUT_PATTERN.exec(content);
  return match ? match[2] : content;
};

/**
 * Turns a `task` tool row into a subagent container, the way Claude's `Agent`
 * rows are: identity from the call, timeline from the child session.
 *
 * `runIsLive` says whether a run of this session is still in progress: a task
 * without a result outside one was stopped and will never report.
 */
const attachOpenCodeSubagent = (
  message: NormalizedMessage,
  state: AnyRecord,
  db: Database.Database | null,
  runIsLive: boolean,
): void => {
  if (message.toolName !== SUBAGENT_TOOL_NAME && message.toolName !== 'task') {
    return;
  }

  const input = readObjectRecord(state.input) ?? {};
  const metadata = readObjectRecord(state.metadata) ?? {};
  const childSessionId = readOptionalString(metadata.sessionID) ?? readOptionalString(metadata.sessionId);
  const toolResult = message.toolResult;
  let status: SubagentInfo['status'] = runIsLive ? 'running' : 'stopped';
  if (metadata.interrupted === true) {
    status = 'stopped';
  } else if (metadata.status === 'running' && childSessionId) {
    status = isOpenCodeSessionActive(childSessionId) ? 'running' : 'stopped';
    if (status === 'stopped' && db) {
      const idle = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'idle' ORDER BY seq DESC LIMIT 1")
        .get(childSessionId) as { data: string } | undefined;
      const outcome = readJsonRecord(idle?.data)?.outcome;
      if (outcome === 'succeeded') status = 'completed';
      if (outcome === 'failed') status = 'failed';
    }
  } else if (toolResult) {
    status = toolResult.isError ? 'failed' : 'completed';
  }

  if (toolResult?.content) {
    toolResult.content = unwrapTaskOutput(toolResult.content);
  }

  const subagent: SubagentInfo = {
    id: childSessionId ?? message.toolId ?? message.id,
    type: readOptionalString(input.agent) ?? readOptionalString(input.subagent_type),
    description: readOptionalString(input.description),
    status,
    model: readOptionalString(readObjectRecord(metadata.model)?.id),
  };

  if (db && childSessionId) {
    try {
      const activity = readOpenCodeSubagentActivity(db, childSessionId);
      if (activity.length > 0) {
        // Keep the latest steps: the timeline says the missing ones are the earlier ones.
        message.subagentTools = activity
          .slice(-MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)
          .map(truncateSubagentActivity);
        subagent.activityCount = activity.length;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to read subagent session ${childSessionId}:`, reason);
    }
  }

  message.subagent = subagent;
};

/** Opens the shared database for a live event, or null when it cannot be read right now. */
const openOpenCodeDatabaseForLiveEvent = (): Database.Database | null => {
  try {
    return openOpenCodeDatabase();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn('[OpenCodeProvider] Failed to open opencode.db for a live event:', reason);
    return null;
  }
};

/** Used by the OpenCode provider to render V2 messages consistently in live chat and history. */
export class OpenCodeSessionsProvider implements IProviderSessions {
  private readonly branches = new OpenCodeForkProvider();

  resolveEditAnchor(sessionId: string, anchorId: string) {
    return this.branches.resolveEditAnchor(sessionId, anchorId);
  }

  rewindSession(sessionId: string, keepThroughId: string | null) {
    return this.branches.rewindSession(sessionId, keepThroughId);
  }

  /** Used by Providers deletion to remove the native session, including children. */
  async deleteSessionData(providerSessionId: string): Promise<boolean> {
    const signal = AbortSignal.timeout(90_000);
    const { client, server } = await startOpenCodeServer(signal);
    try {
      await client.session.remove({ sessionID: providerSessionId }, { signal });
      return true;
    } catch (error) {
      if (isSessionNotFoundError(error)) return false;
      throw error;
    } finally {
      server.close();
    }
  }

  /** Normalizes a V2 message fetched after a content event, using the same ids as history. */
  normalizeMessage(rawMessage: unknown, sessionId: string | null, options: { hydrateSubagents?: boolean } = {}): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (raw?.type !== 'session.message' || !readObjectRecord(raw.message)) return [];
    // Text-only search already has a reader and must not open a new database per row.
    const db = options.hydrateSubagents === false ? null : openOpenCodeDatabaseForLiveEvent();
    try {
      return this.normalizeHistoryRows(messageRows(raw.message), sessionId ?? '', db);
    } finally {
      db?.close();
    }
  }

  /**
   * Loads OpenCode history from the shared SQLite session database.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    // OpenCode's shared sqlite database keys messages by the provider-native
    // session id, not the app-facing id this method is addressed with.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const db = openOpenCodeDatabase();
    if (!db) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    try {
      const rows = readHistoryRows(db, providerSessionId);

      const normalized = this.normalizeHistoryRows(rows, sessionId, db);
      const tokenUsage = readOpenCodeUsage(db, providerSessionId);

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = normalized.length;
      const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to load session ${sessionId}:`, message);
      throw error;
    } finally {
      db.close();
    }
  }

  private normalizeHistoryRows(
    rows: OpenCodeHistoryRow[],
    sessionId: string,
    db: Database.Database | null,
  ): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];
    const emittedMessageErrors = new Set<string>();
    const runIsLive = isOpenCodeSessionActive(sessionId);

    for (const row of rows) {
      const timestamp = normalizeProviderTimestamp(row.part_time_created ?? row.message_time_created);
      const baseId = `${row.message_id}_${row.part_id ?? normalized.length}`;
      const messageInfo = readJsonRecord(row.message_data);
      const messageRole = readOptionalString(messageInfo?.role);

      if (
        messageInfo
        && messageRole === 'assistant'
        && messageInfo.error != null
        && !emittedMessageErrors.has(row.message_id)
      ) {
        emittedMessageErrors.add(row.message_id);
        if (!isStoppedTurnError(messageInfo.error)) {
          normalized.push(createNormalizedMessage({
            id: `${baseId}_error`,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'error',
            content: readEventError(messageInfo.error) ?? formatToolContent(messageInfo.error),
          }));
        }
      }

      if (!row.part_id) {
        continue;
      }

      const partData = readJsonRecord(row.part_data) ?? {};
      const partType = readOptionalString(partData.type);
      if (!partType) {
        continue;
      }

      const special = normalizeSpecialMessage(partData, { id: baseId, sessionId, timestamp, provider: PROVIDER });
      if (special) {
        normalized.push(special);
        continue;
      }

      if (partType === 'text') {
        const rawContent = extractText(partData);
        // User prompts sent with attachments carry an <images_input> path
        // list; strip it for display and surface the paths as images.
        const parsedImages = messageRole === 'user'
          ? parseImagesInputTag(rawContent)
          : { text: rawContent, attachments: [] };
        const parsedFiles = messageRole === 'user'
          ? parseFilesInputTag(parsedImages.text)
          : { text: rawContent, attachments: [] };
        const native = nativeAttachments(partData.attachments);
        const images = [...parsedImages.attachments, ...native.images];
        const files = [...parsedFiles.attachments, ...native.files];
        if (
          parsedFiles.text.trim()
          || images.length > 0
          || files.length > 0
        ) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: messageRole === 'user' ? 'user' : 'assistant',
            content: parsedFiles.text,
            images: images.length > 0 ? images : undefined,
            files: files.length > 0 ? files : undefined,
            ...(messageRole === 'user' ? { transcriptAnchorId: row.message_id } : {}),
          }));
        }
        continue;
      }

      if (partType === 'reasoning') {
        const content = extractText(partData);
        if (content.trim()) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'thinking',
            content,
          }));
        }
        continue;
      }

      if (partType === 'tool') {
        const state = readObjectRecord(partData.state) ?? {};
        const status = readOptionalString(state.status);
        const toolMessage = createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: readOptionalString(partData.tool) ?? 'Tool',
          toolInput: state.input ?? partData.input ?? {},
          toolId: readOptionalString(partData.callID) ?? row.part_id,
          status,
          toolProgress: status === 'running'
            ? readOptionalString(state.metadata?.output) ?? readOptionalString(state.metadata?.description) ?? readOptionalString(state.metadata?.title)
            : undefined,
        });

        if (status === 'completed' || status === 'error') {
          toolMessage.toolResult = {
            content: formatToolContent(state.output ?? state.error),
            isError: status === 'error',
            ...(status === 'error' && readOptionalString(state.errorType) ? { errorType: state.errorType } : {}),
            ...(state.toolUseResult ? { toolUseResult: state.toolUseResult } : {}),
          };
        }

        if (toolMessage.toolName === QUESTION_TOOL_NAME) {
          toAskUserQuestionCall(toolMessage, state);
        }

        attachOpenCodeSubagent(toolMessage, state, db, runIsLive);
        normalized.push(toolMessage);
        continue;
      }

      if (partType === 'step-finish') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'stream_end',
        }));
        continue;
      }

      if (partType === 'patch' || partType === 'agent') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: partType === 'patch' ? 'Patch' : 'Agent',
          toolInput: partData,
          toolId: row.part_id,
        }));
      }
    }

    return normalized;
  }
}
