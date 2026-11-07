import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getConnection, sessionControlDb, sessionsDb, userPreferencesDb } from '@/modules/database/index.js';
import { providerCapabilitiesService, providerModelsService, providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { broadcastSessionUpserted, chatRunRegistry } from '@/modules/websocket/index.js';
import type { LLMProvider, SessionSubmission } from '@/shared/types.js';

import { cursor, enumField, fingerprint, invalid, pageSize, readCursor, stringField } from './session-control.validation.js';

type SubmissionAcknowledgement = Pick<SessionSubmission, 'submissionId' | 'sessionId' | 'state' | 'createdAt'>;

const PROVIDERS = ['claude', 'codex', 'opencode', 'cursor'] as const;

const MODES: Record<string, string> = { default: 'default', auto: 'auto', plan: 'plan', 'accept-edits': 'acceptEdits', 'bypass-permissions': 'bypassPermissions' };

function session(id: string) {
  return sessionsDb.getSessionById(id) ?? invalid('Session not found.', 'SESSION_NOT_FOUND', 404);
}

function permission(userId: number, provider: LLMProvider, id?: string, preferences = userPreferencesDb.getPreferences(userId)): string {
  const stored = id ? sessionsDb.getPermissionMode(id) : null;
  const settings = preferences[`${provider}Permissions`] as {
    permissionMode?: string;
  } | undefined;
  return stored ?? settings?.permissionMode ?? 'default';
}

function receipt<T>(userId: number, operation: string, token: string | undefined, input: unknown, execute: () => T): T {
  if (!token) {
    return execute();
  }
  if (token.length > 128 || !/^[\w.:-]+$/.test(token)) {
    invalid('clientToken must contain 1–128 letters, digits, underscores, dots, colons or hyphens.');
  }
  return getConnection().transaction(() => {
    const hash = fingerprint(input);
    const saved = sessionControlDb.receipt(userId, operation, token);
    if (saved) {
      if (saved.fingerprint !== hash) {
        invalid('clientToken was already used with different input.', 'IDEMPOTENCY_CONFLICT', 409);
      }
      const response = JSON.parse(saved.response);
      if (response.deleted) {
        invalid(`Original session ${response.sessionId} was permanently deleted; this token cannot recreate it.`, 'RESOURCE_DELETED', 410);
      }
      return response as T;
    }
    const result = execute();
    sessionControlDb.saveReceipt(userId, operation, token, hash, result);
    return result;
  })();
}

async function busyIds(): Promise<Set<string>> {
  return new Set((await sessionsService.listRunningSessions()).map((row) => row.sessionId));
}

function describe(id: string, userId: number, running: Set<string>, row = session(id), preferences = userPreferencesDb.getPreferences(userId)) {
  const nativeMode = permission(userId, row.provider as LLMProvider, id, preferences);
  return {
    sessionId: id, providerSessionId: row.provider_session_id, provider: row.provider,
    title: row.custom_name, projectPath: row.project_path, model: row.model,
    permissionMode: Object.entries(MODES).find(([, native]) => native === nativeMode)?.[0] ?? 'default',
    archiveState: row.isArchived ? 'archived' : 'active',
    executionState: running.has(id) ? 'running' : 'idle',
    pendingSubmissions: sessionControlDb.pending(id), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Session management shared by API routes; execution always uses the chat gateway. */
export const sessionControlService = {
  async list(userId: number, input: Record<string, unknown>) {
    const filter = {
      provider: input.provider === undefined ? undefined : enumField(input.provider, 'provider', PROVIDERS),
      projectPath: stringField(input.projectPath, 'projectPath'),
      search: stringField(input.search, 'search'),
      archiveState: enumField(input.archiveState, 'archiveState', ['active', 'archived', 'all'], 'active'),
      executionState: input.executionState === undefined ? undefined : enumField(input.executionState, 'executionState', ['running', 'idle']),
    };
    const scope = fingerprint(filter);
    const position = readCursor(input.startingToken, scope);
    if (position && (position.length !== 2 || !position.every((part) => typeof part === 'string'))) {
      invalid('Invalid starting-token.');
    }
    const running = await busyIds();
    const limit = pageSize(input.maxItems);
    // Idle is filtered in SQL too, using the live snapshot rather than filtering one page afterwards.
    const rows = sessionControlDb.listSessions({ ...filter, runningIds: filter.executionState === 'running' ? [...running] : undefined,
      idleIds: filter.executionState === 'idle' ? [...running] : undefined,
      cursor: (position ?? undefined) as [
        string,
        string
      ] | undefined, limit: limit + 1 });
    const preferences = userPreferencesDb.getPreferences(userId);
    const items = rows.slice(0, limit).map((row) => describe(row.session_id, userId, running, row, preferences));
    const last = rows[limit - 1];
    return { items, nextToken: rows.length > limit ? cursor(scope, [last.updated_at, last.session_id]) : null };
  },
  async show(userId: number, id: string) {
    session(id);
    return describe(id, userId, await busyIds());
  },
  async create(userId: number, input: Record<string, unknown>) {
    const provider = enumField(input.provider, 'provider', PROVIDERS);
    const projectPath = stringField(input.projectPath, 'projectPath', true)!;
    if (!path.isAbsolute(projectPath)) {
      invalid('projectPath must be absolute on the server.');
    }
    const title = stringField(input.title, 'title');
    const requestedModel = stringField(input.model, 'model');
    const mode = input.permissionMode === undefined ? undefined : enumField(input.permissionMode, 'permissionMode', Object.keys(MODES));
    const token = stringField(input.clientToken, 'clientToken');
    const request = { provider, projectPath: path.resolve(projectPath), title, model: requestedModel, permissionMode: mode };
    // Check receipts before filesystem/catalog probes: retries must retain the original result even after deletion.
    const saved = token ? sessionControlDb.receipt(userId, 'create', token) : undefined;
    if (saved) {
      return receipt<ReturnType<typeof describe>>(userId, 'create', token, request, () => invalid('Receipt is missing.'));
    }
    if (!(await fs.stat(projectPath).catch(() => null))?.isDirectory()) {
      invalid('projectPath is not an existing directory.');
    }
    if (!providerRuntimeService.hasRuntime(provider)) {
      invalid('Provider runtime is unavailable.');
    }
    const catalog = await providerModelsService.getProviderModels(provider, projectPath);
    const model = requestedModel ?? catalog.DEFAULT;
    if (!catalog.OPTIONS.some((option) => option.value === model)) {
      invalid('Model is not in the provider catalog.', 'INVALID_MODEL');
    }
    const nativeMode = mode ? MODES[mode] : permission(userId, provider);
    if (!providerCapabilitiesService.getProviderCapabilities(provider).permissionModes.includes(nativeMode)) {
      invalid('Permission mode is not supported by the provider.');
    }
    const result = receipt(userId, 'create', token, request, () => getConnection().transaction(() => {
      const created = sessionsService.createAppSession(provider, request.projectPath, title ?? 'New session');
      if (title) {
        sessionsService.renameSessionById(created.sessionId, title);
      }
      providerModelsService.setSessionModel(provider, created.sessionId, model);
      sessionsDb.setPermissionMode(created.sessionId, nativeMode);
      return describe(created.sessionId, userId, new Set());
    })());
    void broadcastSessionUpserted(result.sessionId).catch((error) => console.error('[SessionControl] Broadcast failed', error));
    return result;
  },
  async send(userId: number, id: string, input: Record<string, unknown>) {
    const content = stringField(input.message, 'message', true)!;
    if (content.length > 1000000) {
      invalid('Message exceeds 1,000,000 characters.');
    }
    const ifBusy = enumField(input.ifBusy, 'ifBusy', ['queue', 'reject'], 'queue');
    const token = stringField(input.clientToken, 'clientToken');
    const request = { sessionId: id, content, ifBusy };
    if (token && sessionControlDb.receipt(userId, 'send', token)) {
      return receipt<SubmissionAcknowledgement>(userId, 'send', token, request, () => invalid('Unreachable'));
    }
    const running = await busyIds();
    if (chatRunRegistry.isMutationReserved(id)) {
      invalid('Session is being modified.', 'SESSION_BUSY', 409);
    }
    return receipt(userId, 'send', token, request, () => {
      const row = session(id);
      if (row.isArchived) {
        invalid('Restore the archived session before sending.', 'SESSION_ARCHIVED', 409);
      }
      if (ifBusy === 'reject' && (running.has(id) || chatRunRegistry.isProcessing(id) || sessionControlDb.pending(id) || sessionControlDb.hasOtherPending(id))) {
        invalid('Session is busy.', 'SESSION_BUSY', 409);
      }
      return this.enqueue(userId, id, content);
    });
  },
  /** Scheduler calls this inside its SQLite transaction; options are validated before storing a task. */
  enqueue(userId: number, id: string, content: string, overrides: { model?: string | null; permissionMode?: string | null } = {}): SubmissionAcknowledgement {
    const row = session(id);
    if (row.isArchived) invalid('Restore the archived session before sending.', 'SESSION_ARCHIVED', 409);
    if (chatRunRegistry.isMutationReserved(id)) invalid('Session is being modified.', 'SESSION_BUSY', 409);
    const now = new Date().toISOString();
    const model = overrides.model ?? row.model;
    const mode = overrides.permissionMode ? MODES[overrides.permissionMode] : permission(userId, row.provider as LLMProvider, id);
    if (!mode) invalid('Unsupported permission mode.');
    const submission: SessionSubmission = {
      submissionId: randomUUID(), sessionId: id, userId, content,
      options: { ...(model ? { model } : {}), permissionMode: mode },
      state: 'queued', result: [], error: null, createdAt: now, updatedAt: now,
    };
    sessionControlDb.insert(submission);
    return { submissionId: submission.submissionId, sessionId: id, state: submission.state, createdAt: now };
  },
  /** Schedule configuration validates overrides without changing the target session's own settings. */
  async validateOverrides(id: string, model: string | null, permissionMode: string | null) {
    const row = session(id);
    if (row.isArchived) invalid('Restore the archived session first.', 'SESSION_ARCHIVED', 409);
    const provider = row.provider as LLMProvider;
    if (permissionMode && !providerCapabilitiesService.getProviderCapabilities(provider).permissionModes.includes(MODES[permissionMode])) {
      invalid('Permission mode is not supported by the provider.');
    }
    if (model) {
      const catalog = await providerModelsService.getProviderModels(provider, row.project_path ?? undefined);
      if (!catalog.OPTIONS.some((option) => option.value === model)) invalid('Model is not in the provider catalog.', 'INVALID_MODEL');
    }
  },
  async change(userId: number, id: string, action: 'archive' | 'restore' | 'delete') {
    session(id);
    if (action === 'restore') {
      const restored = sessionsService.restoreSessionById(id);
      await broadcastSessionUpserted(id);
      return restored;
    }
    if (!chatRunRegistry.reserveMutation(id)) {
      invalid('Session is being modified.', 'SESSION_BUSY', 409);
    }
    try {
      const running = await busyIds();
      if (running.has(id) || chatRunRegistry.isProcessing(id) || sessionControlDb.pending(id) || sessionControlDb.hasOtherPending(id)) {
        invalid('Session has active work or pending messages. Stop or cancel them first.', 'SESSION_BUSY', 409);
      }
      const result = await sessionsService.deleteOrArchiveSessionById(id, { force: action === 'delete', deletedFromDisk: action === 'delete' });
      if (action === 'archive') {
        await broadcastSessionUpserted(id);
      }
      return result;
    } finally {
      chatRunRegistry.releaseMutation(id);
    }
  },
  async messages(id: string, input: Record<string, unknown>) {
    session(id);
    const scope = fingerprint({ sessionId: id, kind: 'messages' });
    const position = readCursor(input.startingToken, scope);
    const offset = position?.[0] ?? 0;
    if (!Number.isInteger(offset) || Number(offset) < 0 || position && position.length !== 1) {
      invalid('Invalid starting-token.');
    }
    const result = await sessionsService.fetchHistory(id, { limit: pageSize(input.maxItems), offset: Number(offset) });
    return { items: result.messages, nextToken: result.hasMore ? cursor(scope, [Number(offset) + result.messages.length]) : null };
  },
  submission(userId: number, id: string, submissionId: string) {
    const row = sessionControlDb.get(submissionId, userId);
    if (!row || row.sessionId !== id) {
      invalid('Submission not found.', 'SUBMISSION_NOT_FOUND', 404);
    }
    return row;
  },
};
