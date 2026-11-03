import { randomUUID } from 'node:crypto';

import {
  getConnection,
  schedulesDb,
  sessionsDb,
  sessionControlDb,
} from '@/modules/database/index.js';
import { sessionControlService, submissionDispatcher } from '@/modules/session-control/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { Schedule, ScheduleRun } from '@/shared/types.js';
import {
  AppError,
  cursor,
  fields,
  fingerprint,
  invalid,
  pageSize,
  readCursor,
} from '@/shared/utils.js';

import {
  definitionOf,
  latestScheduleTime,
  nextScheduleTime,
  scheduleDefinition,
  scheduleTiming,
} from './schedule-timing.js';

function owned(userId: number, id: string, includeDeleted = false): Schedule {
  const task = schedulesDb.get(id);
  if (!task || task.userId !== userId || (task.deleted && !includeDeleted))
    invalid('Schedule not found.', 'SCHEDULE_NOT_FOUND', 404);
  return task;
}
function activeSession(id: string) {
  const session = sessionsDb.getSessionById(id);
  if (!session || session.isArchived)
    invalid('Target session is missing or archived.', 'SESSION_UNAVAILABLE', 409);
  if (chatRunRegistry.isMutationReserved(id))
    invalid('Target session is being modified.', 'SESSION_BUSY', 409);
}
function save(task: Schedule, changes: Partial<Schedule>, now = new Date()): Schedule {
  const updated = {
    ...task,
    ...changes,
    revision: task.revision + 1,
    updatedAt: now.toISOString(),
  };
  schedulesDb.save(updated);
  return updated;
}
function revision(input: unknown, task: Schedule) {
  if (!Number.isSafeInteger(input) || input !== task.revision)
    invalid('Schedule changed; reload and retry with its revision.', 'REVISION_CONFLICT', 409);
}
function receipt<T>(
  userId: number,
  operation: string,
  token: unknown,
  input: unknown,
  perform: () => T,
): T {
  if (token === undefined) return perform();
  if (typeof token !== 'string' || !/^[\w.:-]{1,128}$/.test(token)) invalid('Invalid clientToken.');
  const hash = fingerprint(input);
  const saved = sessionControlDb.receipt(userId, operation, token);
  if (saved) {
    if (saved.fingerprint !== hash)
      invalid('clientToken was already used with different input.', 'IDEMPOTENCY_CONFLICT', 409);
    const result = JSON.parse(saved.response);
    const current = schedulesDb.get(result.scheduleId);
    if (result.deleted || !current || current.deleted)
      invalid('Schedule or session was deleted.', 'RESOURCE_DELETED', 410);
    return result as T;
  }
  const result = perform();
  sessionControlDb.saveReceipt(userId, operation, token, hash, result);
  return result;
}
function record(
  task: Schedule,
  when: string,
  source: ScheduleRun['source'],
  reason: string | null,
  now: Date,
): ScheduleRun {
  const run: ScheduleRun = {
    runId: randomUUID(),
    scheduleId: task.scheduleId,
    sessionId: task.sessionId,
    scheduledFor: when,
    source,
    state: reason ? 'skipped' : 'queued',
    reason,
    submissionId: null,
    createdAt: now.toISOString(),
    snapshot: definitionOf(task),
  };
  if (!reason) {
    const submission = sessionControlService.enqueue(
      task.userId,
      task.sessionId,
      task.message,
      task,
    );
    run.submissionId = submission.submissionId;
  }
  schedulesDb.addRun(run, source === 'scheduled' ? when : run.runId);
  return run;
}

/** API and scheduler share task ownership, edits, trigger transactions and submission lifecycle. */
export const schedulesService = {
  list(userId: number, raw: unknown) {
    const input = fields(raw, ['maxItems', 'startingToken']);
    const scope = `schedules:${userId}`;
    const position = readCursor(input.startingToken, scope);
    if (position && (position.length !== 1 || typeof position[0] !== 'string'))
      invalid('Invalid startingToken.');
    const limit = pageSize(input.maxItems);
    const rows = schedulesDb.list(userId, String(position?.[0] ?? ''), limit + 1);
    return {
      items: rows.slice(0, limit),
      nextToken: rows.length > limit ? cursor(scope, [rows[limit - 1].scheduleId]) : null,
    };
  },
  show: owned,
  preview(raw: unknown, now = new Date()) {
    const timing = scheduleTiming(fields(raw, ['cron', 'runAt', 'timezone']));
    const times: string[] = [];
    let after = now;
    for (let i = 0; i < 5; i++) {
      const next = nextScheduleTime(timing, after);
      if (!next) break;
      times.push(next);
      after = new Date(next);
    }
    return { ...timing, times };
  },
  async create(userId: number, raw: unknown) {
    const {
      clientToken,
      enabled = true,
      ...data
    } = fields(raw, [
      'name',
      'sessionId',
      'message',
      'cron',
      'runAt',
      'timezone',
      'misfirePolicy',
      'model',
      'permissionMode',
      'enabled',
      'clientToken',
    ]);
    if (typeof enabled !== 'boolean') invalid('enabled must be boolean.');
    const definition = scheduleDefinition(data);
    const request = { ...definition, enabled };
    // Retry receipts before probing the target: an acknowledged create remains acknowledged after it runs.
    if (
      typeof clientToken === 'string' &&
      sessionControlDb.receipt(userId, 'schedule.create', clientToken)
    ) {
      return receipt<Schedule>(userId, 'schedule.create', clientToken, request, () =>
        invalid('Missing receipt.'),
      );
    }
    await sessionControlService.validateOverrides(
      definition.sessionId,
      definition.model,
      definition.permissionMode,
    );
    return getConnection().transaction(() =>
      receipt(userId, 'schedule.create', clientToken, request, () => {
        activeSession(definition.sessionId);
        const now = new Date();
        const nextRunAt = nextScheduleTime(definition, now);
        if (!nextRunAt) invalid('runAt must be in the future.');
        const task: Schedule = {
          ...definition,
          scheduleId: randomUUID(),
          userId,
          enabled,
          deleted: false,
          revision: 1,
          nextRunAt: enabled ? nextRunAt : null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        schedulesDb.save(task);
        return task;
      }),
    )();
  },
  async update(userId: number, id: string, raw: unknown) {
    const { revision: expected, ...changes } = fields(raw, [
      'revision',
      'name',
      'message',
      'cron',
      'runAt',
      'timezone',
      'misfirePolicy',
      'model',
      'permissionMode',
    ]);
    const before = owned(userId, id);
    revision(expected, before);
    const definition = scheduleDefinition({ ...definitionOf(before), ...changes });
    await sessionControlService.validateOverrides(
      before.sessionId,
      definition.model,
      definition.permissionMode,
    );
    return getConnection().transaction(() => {
      const current = owned(userId, id);
      revision(expected, current);
      activeSession(current.sessionId);
      const timingChanged =
        definition.cron !== current.cron ||
        definition.runAt !== current.runAt ||
        definition.timezone !== current.timezone;
      const nextRunAt = timingChanged
        ? nextScheduleTime(definition, new Date())
        : current.nextRunAt;
      if (current.enabled && !nextRunAt) invalid('runAt must be in the future.');
      return save(current, { ...definition, nextRunAt: current.enabled ? nextRunAt : null });
    })();
  },
  change(userId: number, id: string, action: 'pause' | 'resume' | 'delete') {
    return getConnection().transaction(() => {
      const task = owned(userId, id, action === 'delete');
      if (action === 'resume') {
        if (task.enabled) return task;
        activeSession(task.sessionId);
        const nextRunAt = nextScheduleTime(task, new Date());
        if (!nextRunAt) invalid('Update the one-time runAt before resuming.');
        return save(task, { enabled: true, nextRunAt });
      }
      return save(task, {
        enabled: false,
        nextRunAt: null,
        deleted: action === 'delete' || task.deleted,
      });
    })();
  },
  run(userId: number, id: string, raw: unknown = {}) {
    const input = fields(raw, ['clientToken']);
    return getConnection().transaction(() =>
      receipt(userId, 'schedule.run', input.clientToken, { scheduleId: id }, () => {
        const task = owned(userId, id);
        activeSession(task.sessionId);
        if (schedulesDb.pending(id))
          invalid('The previous execution has not finished.', 'SCHEDULE_BUSY', 409);
        const now = new Date();
        return record(task, now.toISOString(), 'manual', null, now);
      }),
    )();
  },
  runs(userId: number, id: string, raw: unknown) {
    owned(userId, id, true);
    const input = fields(raw, ['maxItems', 'startingToken']);
    const scope = `schedule-runs:${userId}:${id}`;
    const position = readCursor(input.startingToken, scope);
    if (position && (position.length !== 2 || !position.every((v) => typeof v === 'string')))
      invalid('Invalid startingToken.');
    const limit = pageSize(input.maxItems);
    const rows = schedulesDb.runs(id, position as [string, string] | null, limit + 1);
    const last = rows[limit - 1];
    return {
      items: rows.slice(0, limit),
      nextToken: rows.length > limit ? cursor(scope, [last.createdAt, last.runId]) : null,
    };
  },
  execution(userId: number, id: string, runId: string) {
    owned(userId, id, true);
    const run = schedulesDb.run(runId);
    if (!run || run.scheduleId !== id) invalid('Execution not found.', 'RUN_NOT_FOUND', 404);
    return {
      ...run,
      submission: run.submissionId
        ? sessionControlService.submission(userId, run.sessionId, run.submissionId)
        : null,
    };
  },
  async cancel(userId: number, id: string, runId: string) {
    const run = this.execution(userId, id, runId);
    if (run.submissionId)
      await submissionDispatcher.cancel(userId, run.sessionId, run.submissionId);
    return this.execution(userId, id, runId);
  },
};

/** Called by the server timer and deterministic tests. Each task's progression and enqueue commit atomically. */
export function dispatchSchedules(now = new Date()): number {
  let count = 0;
  for (const candidate of schedulesDb.due(now.toISOString())) {
    try {
      count += getConnection().transaction(() => dispatchOne(candidate.scheduleId, now))();
    } catch (error) {
      console.error('[Schedules] Dispatch failed', { scheduleId: candidate.scheduleId, error });
    }
  }
  return count;
}
function dispatchOne(id: string, now: Date): number {
  const task = schedulesDb.get(id);
  if (!task?.enabled || task.deleted || !task.nextRunAt || task.nextRunAt > now.toISOString())
    return 0;
  if (chatRunRegistry.isMutationReserved(task.sessionId)) return 0;
  const session = sessionsDb.getSessionById(task.sessionId);
  if (!session || session.isArchived) {
    save(task, { enabled: false, nextRunAt: null }, now);
    return 0;
  }
  const late = now.getTime() - Date.parse(task.nextRunAt) >= 60000;
  const when =
    late && task.misfirePolicy === 'latest' ? latestScheduleTime(task, now) : task.nextRunAt;
  const reason =
    late && task.misfirePolicy === 'skip'
      ? `Missed occurrence(s) between ${task.nextRunAt} and ${now.toISOString()}.`
      : schedulesDb.pending(id)
        ? 'Previous execution is still queued, running or waiting for input.'
        : null;
  try {
    record(task, when, 'scheduled', reason, now);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const run: ScheduleRun = {
      runId: randomUUID(),
      scheduleId: id,
      sessionId: task.sessionId,
      scheduledFor: when,
      source: 'scheduled',
      state: 'failed',
      reason: error.message,
      submissionId: null,
      createdAt: now.toISOString(),
      snapshot: definitionOf(task),
    };
    schedulesDb.addRun(run, when);
  }
  const nextRunAt = nextScheduleTime(task, now);
  save(task, { nextRunAt, enabled: Boolean(nextRunAt) }, now);
  return 1;
}
