import cronstrue from 'cronstrue';
import 'cronstrue/locales/zh_CN';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { ScheduleTime } from '@/modules/schedules/ScheduleTime';

/** ScheduleForm keys this preview by timing, so an old request cannot replace a newer draft. */
export function SchedulePreview({
  cron,
  runAt,
  timezone,
}: {
  cron: string | null;
  runAt: string | null;
  timezone: string;
}) {
  const { t, i18n } = useTranslation('common');
  // The server is the scheduling authority; pending and failures remain distinct from no future dates.
  const [result, setResult] = useState<
    { times: string[]; summary: string } | { error: string } | null
  >(null);
  const language = i18n.language;
  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(async () => {
      try {
        const data = await readApiJson<{ times: string[] }>(
          await api.schedules.preview({ cron, runAt, timezone }),
        );
        const summary = cron
          ? cronstrue.toString(cron, {
              locale: language.startsWith('zh') ? 'zh_CN' : 'en',
              use24HourTimeFormat: true,
            })
          : runAt!;
        if (!disposed) setResult({ times: data.times, summary });
      } catch (error) {
        if (!disposed) setResult({ error: (error as Error).message });
      }
    }, 300);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [cron, runAt, timezone, language]);
  return (
    <section
      aria-label={t('schedules.preview')}
      aria-live="polite"
      className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground"
    >
      <p className="mb-1 font-medium text-foreground">
        {t(cron ? 'schedules.nextFive' : 'schedules.next')}
      </p>
      {!result ? (
        <p>{t('schedules.loading')}</p>
      ) : 'error' in result ? (
        <p role="alert" className="text-destructive">
          {result.error}
        </p>
      ) : (
        <>
          <p>
            {cron ? result.summary : runAt && <ScheduleTime value={runAt} timezone={timezone} />} · {timezone}
          </p>
          {result.times.length === 0 ? (
            <p>{t('schedules.noFuture')}</p>
          ) : (
            <ol className="mt-2 space-y-1 tabular-nums">
              {result.times.map((time) => (
                <li key={time}>
                  <ScheduleTime value={time} timezone={timezone} />
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
