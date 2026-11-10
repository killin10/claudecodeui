import cronstrue from 'cronstrue';
import 'cronstrue/locales/zh_CN';

import type { Schedule } from '@/shared/types';

/** A ready-made cron rule the form offers; `custom` means the user typed their own. */
export type CronPresetKey = 'weekdays' | 'daily' | 'weekly' | 'hourly' | 'monthly' | 'custom';

/** Where a task stands as the card shows it: firing, stopped by hand or the system, or a one-time task that already fired. */
export type ScheduleTaskStatus = 'enabled' | 'paused' | 'completed';

/** The cron rules behind the form's quick-rule picker, in display order. */
export const CRON_PRESETS: Array<{ key: Exclude<CronPresetKey, 'custom'>; cron: string }> = [
  { key: 'weekdays', cron: '0 9 * * 1-5' },
  { key: 'daily', cron: '0 9 * * *' },
  { key: 'weekly', cron: '0 9 * * 1' },
  { key: 'hourly', cron: '0 * * * *' },
  { key: 'monthly', cron: '0 9 1 * *' },
];

/** Zones most tasks use; the picker shows these until it is opened, then every zone. */
export const COMMON_TIME_ZONES = [
  'UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Kolkata', 'Europe/London',
  'Europe/Berlin', 'Europe/Paris', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Sao_Paulo', 'Australia/Sydney',
];

/** Which preset a cron string is, or `custom` when it matches none. */
export const cronPresetOf = (cron: string): CronPresetKey => (
  CRON_PRESETS.find((preset) => preset.cron === cron.trim())?.key ?? 'custom'
);

/**
 * Every IANA zone the browser knows, so the picker is a list rather than a free
 * text field. Falls back to a short common list on browsers without
 * `Intl.supportedValuesOf`, always including the zones the form must show.
 */
export const listTimeZones = (...include: string[]): string[] => {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  let zones: string[];
  try {
    zones = intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : COMMON_TIME_ZONES;
  } catch {
    zones = COMMON_TIME_ZONES;
  }
  // Runtimes list regional zones only; UTC is the one every form must offer.
  const known = new Set(['UTC', ...zones]);
  include.filter(Boolean).forEach((zone) => known.add(zone));
  return [...known].sort((left, right) => left.localeCompare(right));
};

/** The browser's own zone, which is what a new task should default to. */
export const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const PART_TYPES = ['year', 'month', 'day', 'hour', 'minute', 'second'] as const;

/** Wall-clock parts of an instant in a zone, read from Intl parts so no locale formatting leaks in. */
const wallClockIn = (date: Date, timezone: string): Record<(typeof PART_TYPES)[number], number> => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const read = (type: (typeof PART_TYPES)[number]) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') % 24, minute: read('minute'), second: read('second') };
};

const zoneOffsetMs = (date: Date, timezone: string): number => {
  const wall = wallClockIn(date, timezone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - date.getTime();
};

const pad = (value: number) => String(value).padStart(2, '0');

/** An instant as the `datetime-local` value showing its wall-clock time in `timezone`. */
export const toZonedInputValue = (iso: string, timezone: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const wall = wallClockIn(date, timezone);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
};

/**
 * The instant a `datetime-local` value names when read as wall-clock time in
 * `timezone`, as a UTC ISO string the API accepts. Null when the value is not a
 * complete date and time. Re-reads the offset at the resolved instant so a time
 * on a DST boundary lands on the right side of it.
 */
export const zonedInputValueToIso = (value: string, timezone: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const asUtc = Date.parse(`${value.length === 16 ? `${value}:00` : value}Z`);
  if (Number.isNaN(asUtc)) return null;
  try {
    const firstOffset = zoneOffsetMs(new Date(asUtc), timezone);
    let instant = asUtc - firstOffset;
    const secondOffset = zoneOffsetMs(new Date(instant), timezone);
    if (secondOffset !== firstOffset) instant = asUtc - secondOffset;
    return new Date(instant).toISOString();
  } catch {
    return null;
  }
};

/** Quick one-time choices, as `datetime-local` values in `timezone`. */
export const quickRunAtValues = (timezone: string, now = new Date()): Array<{ key: 'inOneHour' | 'tomorrowMorning' | 'nextMonday'; value: string }> => {
  const wall = wallClockIn(now, timezone);
  const dayAt = (offsetDays: number, hour: number) => {
    const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + offsetDays, hour, 0, 0));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(hour)}:00`;
  };
  // Days until next Monday (1), never zero: "next Monday" on a Monday means a week ahead.
  const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  const untilMonday = ((8 - weekday) % 7) || 7;
  return [
    { key: 'inOneHour', value: toZonedInputValue(new Date(now.getTime() + 3_600_000).toISOString(), timezone) },
    { key: 'tomorrowMorning', value: dayAt(1, 9) },
    { key: 'nextMonday', value: dayAt(untilMonday, 9) },
  ];
};

/** A cron rule in words, in the UI language; falls back to the raw rule when it cannot be read. */
export const describeCron = (cron: string, language: string): string => {
  try {
    return cronstrue.toString(cron, {
      locale: language.startsWith('zh') ? 'zh_CN' : 'en',
      use24HourTimeFormat: true,
    });
  } catch {
    return cron;
  }
};

/**
 * The status the card shows. A one-time task is disabled by the server once it
 * fires, which is completion rather than a pause; a disabled one that never
 * ran is paused.
 */
export const scheduleTaskStatus = (task: Pick<Schedule, 'enabled' | 'runAt' | 'lastState'>): ScheduleTaskStatus => {
  if (task.enabled) return 'enabled';
  return task.runAt && task.lastState ? 'completed' : 'paused';
};

/** Whether a run is still going, which blocks "run now" and offers cancellation. */
export const isRunInProgress = (state: string | null | undefined): boolean => (
  state === 'queued' || state === 'running' || state === 'waiting-for-input'
);
