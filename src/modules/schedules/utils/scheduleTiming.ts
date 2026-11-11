import cronstrue from 'cronstrue';
import 'cronstrue/locales/zh_CN';

import type { Schedule } from '@/shared/types';

/** Where a task stands as the card shows it: firing, stopped by hand or the system, or a one-time task that already fired. */
export type ScheduleTaskStatus = 'enabled' | 'paused' | 'completed';

/** The repeat patterns the cron helper can write; anything else is edited as raw cron. */
export type CronHelperFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'hourly';

/**
 * The cron helper's controls. They only ever produce a cron string; the cron
 * field stays the one value that is saved. Days of week use cron's 0 = Sunday.
 */
export type CronHelperState = {
  frequency: CronHelperFrequency;
  hour: number;
  minute: number;
  weekdays: number[];
  dayOfMonth: number;
};

/** What a new task starts from: weekdays at 09:00. */
export const DEFAULT_CRON_HELPER: CronHelperState = { frequency: 'weekdays', hour: 9, minute: 0, weekdays: [1], dayOfMonth: 1 };

const integerIn = (value: string, min: number, max: number): number | null => (
  /^\d{1,2}$/.test(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null
);

/** Cron text for helper controls. Weekly with no day picked falls back to Monday rather than an invalid rule. */
export const buildCron = (state: CronHelperState): string => {
  const { minute, hour } = state;
  switch (state.frequency) {
    case 'hourly': return `${minute} * * * *`;
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly': {
      const days = [...new Set(state.weekdays)].sort((left, right) => left - right);
      return `${minute} ${hour} * * ${days.length ? days.join(',') : '1'}`;
    }
    case 'monthly': return `${minute} ${hour} ${state.dayOfMonth} * *`;
  }
};

/**
 * Helper controls matching a cron string, or null when the rule is not one the
 * helper writes (steps, ranges other than 1-5, several hours, …). `fallback`
 * supplies the fields a frequency does not use, so switching keeps them.
 */
export const parseCron = (cron: string, fallback: CronHelperState = DEFAULT_CRON_HELPER): CronHelperState | null => {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
  const minute = integerIn(minuteField, 0, 59);
  if (minute === null || monthField !== '*') return null;
  if (hourField === '*' && dayField === '*' && weekdayField === '*') {
    return { ...fallback, frequency: 'hourly', minute };
  }
  const hour = integerIn(hourField, 0, 23);
  if (hour === null) return null;
  const base = { ...fallback, hour, minute };
  if (dayField === '*' && weekdayField === '*') return { ...base, frequency: 'daily' };
  if (dayField === '*' && weekdayField === '1-5') return { ...base, frequency: 'weekdays' };
  if (dayField === '*') {
    const days = weekdayField.split(',').map((day) => integerIn(day, 0, 7));
    if (days.some((day) => day === null)) return null;
    // Cron accepts 7 for Sunday too.
    return { ...base, frequency: 'weekly', weekdays: [...new Set(days.map((day) => (day as number) % 7))].sort() };
  }
  const dayOfMonth = integerIn(dayField, 1, 31);
  if (dayOfMonth !== null && weekdayField === '*') return { ...base, frequency: 'monthly', dayOfMonth };
  return null;
};

/** Zones most tasks use; the picker shows these until it is opened, then every zone. */
export const COMMON_TIME_ZONES = [
  'UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Kolkata', 'Europe/London',
  'Europe/Berlin', 'Europe/Paris', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Sao_Paulo', 'Australia/Sydney',
];

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
