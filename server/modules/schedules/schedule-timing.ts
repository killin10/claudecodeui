import { CronExpressionParser } from 'cron-parser';

import type { ScheduleDefinition } from '@/shared/types.js';
import { fields, invalid, stringField, enumField } from '@/shared/utils.js';

function zone(value: unknown): string {
  const timezone = stringField(value, 'timezone', true)!;
  if (timezone.length > 100) invalid('timezone is too long.');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    invalid('timezone must be an IANA time zone, for example Asia/Shanghai.');
  }
  return timezone;
}

function timestamp(value: unknown): string {
  const text = stringField(value, 'runAt', true)!;
  if (
    !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(text) ||
    !Number.isFinite(Date.parse(text))
  ) {
    invalid('runAt must be an ISO timestamp with an explicit offset.');
  }
  const datePart = text.slice(0, 10);
  if (new Date(datePart + 'T00:00:00Z').toISOString().slice(0, 10) !== datePart) {
    invalid('runAt contains an invalid calendar date.');
  }
  return new Date(text).toISOString();
}

/** Schedule service uses a five-field numeric cron contract, with explicit IANA timezone and deterministic UTC instants. */
export function nextScheduleTime(
  definition: Pick<ScheduleDefinition, 'cron' | 'runAt' | 'timezone'>,
  after: Date,
): string | null {
  if (definition.runAt) return definition.runAt > after.toISOString() ? definition.runAt : null;
  try {
    return CronExpressionParser.parse(definition.cron!, {
      currentDate: after,
      tz: definition.timezone,
    })
      .next()
      .toISOString();
  } catch (error) {
    invalid(`Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Produces at most one catch-up occurrence even after a long outage. */
export function latestScheduleTime(definition: ScheduleDefinition, now: Date): string {
  if (definition.runAt) return definition.runAt;
  return CronExpressionParser.parse(definition.cron!, {
    currentDate: new Date(now.getTime() + 1),
    tz: definition.timezone,
  })
    .prev()
    .toISOString()!;
}

/** Preview endpoint and task validation share the same parser; no seconds, macros or randomized extensions. */
export function scheduleTiming(input: Record<string, unknown>) {
  const timezone = zone(input.timezone);
  const cron =
    input.cron === null || input.cron === undefined
      ? null
      : stringField(input.cron, 'cron', true)!.trim();
  const runAt = input.runAt === null || input.runAt === undefined ? null : timestamp(input.runAt);
  if (Boolean(cron) === Boolean(runAt)) invalid('Specify exactly one of cron or runAt.');
  if (
    cron &&
    (cron.length > 256 || cron.split(/\s+/).length !== 5 || !/^[\d*,/\s-]+$/.test(cron))
  ) {
    invalid('cron must contain five numeric fields: minute hour day-of-month month day-of-week.');
  }
  const timing = { cron, runAt, timezone };
  nextScheduleTime(timing, new Date());
  return timing;
}

/** Validates task fields; update merges a complete prior definition before reaching this function. */
export function scheduleDefinition(input: unknown): ScheduleDefinition {
  const data = fields(input, [
    'name',
    'sessionId',
    'message',
    'cron',
    'runAt',
    'timezone',
    'misfirePolicy',
    'model',
    'permissionMode',
  ]);
  const name = stringField(data.name, 'name', true)!.trim();
  const message = stringField(data.message, 'message', true)!;
  if (name.length > 200 || message.length > 1000000)
    invalid('Name is limited to 200 characters and message to 1,000,000 characters.');
  return {
    name,
    message,
    sessionId: stringField(data.sessionId, 'sessionId', true)!,
    ...scheduleTiming(data),
    misfirePolicy: enumField(data.misfirePolicy, 'misfirePolicy', ['skip', 'latest'], 'skip'),
    model: data.model === null ? null : (stringField(data.model, 'model') ?? null),
    permissionMode:
      data.permissionMode === null || data.permissionMode === undefined
        ? null
        : enumField(data.permissionMode, 'permissionMode', [
            'default',
            'auto',
            'plan',
            'accept-edits',
            'bypass-permissions',
          ]),
  };
}

/** Snapshot stored on each execution, independent of later edits. */
export function definitionOf(value: ScheduleDefinition): ScheduleDefinition {
  const { name, sessionId, message, cron, runAt, timezone, misfirePolicy, model, permissionMode } =
    value;
  return { name, sessionId, message, cron, runAt, timezone, misfirePolicy, model, permissionMode };
}
