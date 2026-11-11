import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import {
  buildCron,
  DEFAULT_CRON_HELPER,
  parseCron,
  type CronHelperFrequency,
  type CronHelperState,
} from '@/modules/schedules/utils/scheduleTiming';

const FREQUENCIES: CronHelperFrequency[] = ['daily', 'weekdays', 'weekly', 'monthly', 'hourly'];
/** Monday first, as people read a week; values are cron's 0 = Sunday. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Used by ScheduleForm above its cron field. The cron string is the only saved
 * value: these controls are read from it when it is a pattern they can show,
 * and every change writes a new cron string back. Any other rule is typed by
 * hand; picking a frequency then replaces it.
 */
export function ScheduleCronHelper({
  cron, onChange, controlClassName,
}: { cron: string; onChange: (cron: string) => void; controlClassName: string }) {
  const { t } = useTranslation('common');
  // Fields the current frequency does not use (e.g. the time while hourly), kept so switching back restores them.
  const [remembered, setRemembered] = useState<CronHelperState>(() => parseCron(cron) ?? DEFAULT_CRON_HELPER);
  // The cron last seen, so a rule typed into the field also becomes what the helper remembers.
  const [seenCron, setSeenCron] = useState(cron);
  if (cron !== seenCron) {
    setSeenCron(cron);
    const typed = parseCron(cron, remembered);
    if (typed) setRemembered(typed);
  }
  const parsed = parseCron(cron, remembered);
  const state = parsed ?? remembered;

  const apply = (patch: Partial<CronHelperState>) => {
    const next = { ...state, ...patch };
    setRemembered(next);
    onChange(buildCron(next));
  };

  const timeValue = `${pad(state.hour)}:${pad(state.minute)}`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t('schedules.helper.frequency')}
          value={parsed ? parsed.frequency : ''}
          onChange={(event) => event.target.value && apply({ frequency: event.target.value as CronHelperFrequency })}
          className={cn(controlClassName, 'w-auto min-w-32')}
        >
          {!parsed && <option value="">{t('schedules.helper.custom')}</option>}
          {FREQUENCIES.map((frequency) => (
            <option key={frequency} value={frequency}>{t(`schedules.helper.frequencies.${frequency}`)}</option>
          ))}
        </select>

        {parsed && parsed.frequency === 'monthly' && (
          <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <input
              type="number"
              min={1}
              max={31}
              aria-label={t('schedules.helper.dayOfMonth')}
              value={state.dayOfMonth}
              onChange={(event) => {
                const day = Number(event.target.value);
                if (Number.isInteger(day) && day >= 1 && day <= 31) apply({ dayOfMonth: day });
              }}
              className={cn(controlClassName, 'w-20')}
            />
            {t('schedules.helper.daySuffix')}
          </label>
        )}

        {parsed && parsed.frequency === 'hourly' ? (
          <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            {t('schedules.helper.atMinutePrefix')}
            <input
              type="number"
              min={0}
              max={59}
              aria-label={t('schedules.helper.minute')}
              value={state.minute}
              onChange={(event) => {
                const minute = Number(event.target.value);
                if (Number.isInteger(minute) && minute >= 0 && minute <= 59) apply({ minute });
              }}
              className={cn(controlClassName, 'w-20')}
            />
            {t('schedules.helper.atMinuteSuffix')}
          </label>
        ) : parsed && (
          <input
            type="time"
            aria-label={t('schedules.helper.time')}
            value={timeValue}
            onChange={(event) => {
              const match = /^(\d{2}):(\d{2})/.exec(event.target.value);
              if (match) apply({ hour: Number(match[1]), minute: Number(match[2]) });
            }}
            className={cn(controlClassName, 'w-32')}
          />
        )}
      </div>

      {parsed && parsed.frequency === 'weekly' && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('schedules.helper.weekdays')}>
          {WEEK_ORDER.map((day) => {
            const active = state.weekdays.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  const weekdays = active ? state.weekdays.filter((value) => value !== day) : [...state.weekdays, day];
                  // At least one day: an empty selection is not a rule.
                  if (weekdays.length) apply({ weekdays });
                }}
                className={cn(
                  'h-8 min-w-10 rounded-md border px-2 text-xs transition-colors',
                  active
                    ? 'border-primary/60 bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
                )}
              >
                {t(`schedules.helper.weekdayNames.${day}`)}
              </button>
            );
          })}
        </div>
      )}

      {parsed && parsed.frequency === 'monthly' && state.dayOfMonth > 28 && (
        <p className="text-xs text-muted-foreground">{t('schedules.helper.shortMonths', { day: state.dayOfMonth })}</p>
      )}
      {!parsed && (
        <p className="text-xs text-muted-foreground">{t('schedules.helper.customHint')}</p>
      )}
    </div>
  );
}
