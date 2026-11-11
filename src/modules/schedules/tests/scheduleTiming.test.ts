import { expect, test } from 'vitest';

import {
  buildCron,
  DEFAULT_CRON_HELPER,
  describeCron,
  isRunInProgress,
  parseCron,
  quickRunAtValues,
  scheduleTaskStatus,
  toZonedInputValue,
  zonedInputValueToIso,
} from '@/modules/schedules/utils/scheduleTiming';

test('a picker value is read as wall-clock time in the zone and round-trips through the instant', () => {
  expect(zonedInputValueToIso('2031-03-05T09:30', 'Asia/Shanghai')).toBe('2031-03-05T01:30:00.000Z');
  expect(zonedInputValueToIso('2031-07-04T12:00', 'America/New_York')).toBe('2031-07-04T16:00:00.000Z');
  expect(zonedInputValueToIso('2031-01-04T12:00', 'America/New_York')).toBe('2031-01-04T17:00:00.000Z');
  expect(toZonedInputValue('2031-03-05T01:30:00.000Z', 'Asia/Shanghai')).toBe('2031-03-05T09:30');
  expect(toZonedInputValue('2031-01-01T00:00:00Z', 'Asia/Tokyo')).toBe('2031-01-01T09:00');
  expect(zonedInputValueToIso('2031-03-05', 'UTC')).toBeNull();
  expect(zonedInputValueToIso('', 'UTC')).toBeNull();
});

test('quick one-time choices are wall-clock values in the zone', () => {
  // Wednesday 2031-03-05 22:30 in Shanghai (14:30Z).
  const now = new Date('2031-03-05T14:30:00Z');
  const values = Object.fromEntries(quickRunAtValues('Asia/Shanghai', now).map((entry) => [entry.key, entry.value]));
  expect(values.inOneHour).toBe('2031-03-05T23:30');
  expect(values.tomorrowMorning).toBe('2031-03-06T09:00');
  expect(values.nextMonday).toBe('2031-03-10T09:00');
  // On a Monday, "next Monday" is a week ahead, never today.
  const monday = Object.fromEntries(quickRunAtValues('UTC', new Date('2031-03-10T08:00:00Z')).map((entry) => [entry.key, entry.value]));
  expect(monday.nextMonday).toBe('2031-03-17T09:00');
});

test('the cron helper round-trips the rules it writes and declines the rest', () => {
  const rules = ['0 9 * * *', '30 18 * * 1-5', '0 9 * * 1,3,5', '15 8 31 * *', '45 * * * *'];
  for (const rule of rules) expect(buildCron(parseCron(rule)!)).toBe(rule);
  expect(parseCron('0 9 * * 7')?.weekdays).toEqual([0]);
  expect(parseCron(' 0  9 * * 1-5 ')?.frequency).toBe('weekdays');
  for (const rule of ['*/15 * * * *', '0 9-17 * * *', '0 9 1 1 *', '0 9 1 * 1', '0 24 * * *', '0 9 * * 8', 'nonsense']) {
    expect(parseCron(rule)).toBeNull();
  }
  // Fields a frequency ignores come from the fallback, so switching back restores them.
  expect(parseCron('10 * * * *', { ...DEFAULT_CRON_HELPER, hour: 18 })).toMatchObject({ frequency: 'hourly', minute: 10, hour: 18 });
  expect(buildCron({ ...DEFAULT_CRON_HELPER, frequency: 'weekly', weekdays: [] })).toBe('0 9 * * 1');
});

test('cron wording and statuses follow the task', () => {
  expect(describeCron('0 9 * * 1-5', 'en')).toMatch(/Monday through Friday/);
  expect(describeCron('not a cron', 'en')).toBe('not a cron');
  expect(scheduleTaskStatus({ enabled: true, runAt: null, lastState: null })).toBe('enabled');
  expect(scheduleTaskStatus({ enabled: false, runAt: null, lastState: 'succeeded' })).toBe('paused');
  expect(scheduleTaskStatus({ enabled: false, runAt: '2030-01-01T00:00:00Z', lastState: null })).toBe('paused');
  expect(scheduleTaskStatus({ enabled: false, runAt: '2030-01-01T00:00:00Z', lastState: 'failed' })).toBe('completed');
  expect(isRunInProgress('waiting-for-input')).toBe(true);
  expect(isRunInProgress('succeeded')).toBe(false);
  expect(isRunInProgress(null)).toBe(false);
});
