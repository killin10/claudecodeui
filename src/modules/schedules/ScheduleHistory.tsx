import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { api, readApiJson } from '@/shared/api';
import type { ScheduleRun } from '@/shared/types';

/** Task history reports persisted trigger state and the provider's actual submission result. */
export function ScheduleHistory({ scheduleId }: { scheduleId: string }) {
  const { t } = useTranslation('common');
  // The loaded history pages are refreshed together so pagination never silently drops older rows.
  const [page, setPage] = useState<{ items: ScheduleRun[]; nextToken: string | null }>({
    items: [],
    nextToken: null,
  });
  // Errors preserve existing history and remain distinguishable from a valid empty history.
  const [error, setError] = useState('');
  // Fetch failures and action failures have separate lifetimes: polling must not clear a cancellation error.
  const [fetchError, setFetchError] = useState('');
  // Explicit detail expansion loads potentially large submission output only on demand.
  const [detail, setDetail] = useState<string | null>(null);
  // A reload request follows load-more or cancellation, while polling also observes external changes.
  const [refresh, setRefresh] = useState(0);
  // Prevents simultaneous cancel actions in this history view.
  const [busy, setBusy] = useState(false);
  const pages = useRef(1);
  const detailGeneration = useRef(0);
  useEffect(() => {
    const detailEpoch = detailGeneration;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        let nextToken: string | null = null;
        const items: ScheduleRun[] = [];
        for (let i = 0; i < pages.current; i++) {
          const result: typeof page = await readApiJson(
            await api.schedules.runs(scheduleId, nextToken ?? undefined),
          );
          if (disposed) return;
          items.push(...result.items);
          nextToken = result.nextToken;
          if (!nextToken) break;
        }
        setPage({ items, nextToken });
        setFetchError('');
      } catch (e) {
        if (!disposed) setFetchError((e as Error).message);
      }
      if (!disposed) timer = setTimeout(() => void poll(), 5000);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      detailEpoch.current++;
    };
  }, [scheduleId, refresh]);
  async function show(run: ScheduleRun) {
    setError('');
    const current = ++detailGeneration.current;
    try {
      const result = await readApiJson<{
        submission: { result: { content?: string; text?: string }[]; error: string | null } | null;
        reason: string | null;
      }>(await api.schedules.run(scheduleId, run.runId));
      if (current === detailGeneration.current) {
        const output = result.submission?.result
          ?.map((message) => message.content ?? message.text ?? '')
          .filter(Boolean)
          .join('\n\n');
        setDetail(
          [output, result.submission?.error ?? result.reason].filter(Boolean).join('\n\n') ||
            t('schedules.noResult'),
        );
      }
    } catch (e) {
      if (current === detailGeneration.current) setError((e as Error).message);
    }
  }
  async function cancel(run: ScheduleRun) {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await readApiJson(await api.schedules.cancel(scheduleId, run.runId));
      setRefresh((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-4 space-y-3 rounded-lg border p-4" aria-label={t('schedules.history')}>
      <h2 className="font-medium">{t('schedules.history')}</h2>
      {(error || fetchError) && (
        <p role="alert" className="text-destructive">
          {error || fetchError}
        </p>
      )}
      {page.items.map((run) => (
        <div key={run.runId} className="space-y-1 border-b py-2 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <time>{new Date(run.scheduledFor).toLocaleString()}</time>
            <span>{t(`schedules.states.${run.state}`, { defaultValue: run.state })}</span>
            <span>{t(`schedules.${run.source}`)}</span>
          </div>
          {run.reason && <p className="break-words text-muted-foreground">{run.reason}</p>}
          <div className="flex gap-4">
            <Link
              className="text-primary underline"
              to={`/session/${encodeURIComponent(run.sessionId)}`}
            >
              {t('schedules.openSession')}
            </Link>
            <button onClick={() => void show(run)}>{t('schedules.result')}</button>
            {['queued', 'running', 'waiting-for-input'].includes(run.state) && (
              <button disabled={busy} className="text-destructive" onClick={() => void cancel(run)}>
                {t('schedules.cancelRun')}
              </button>
            )}
          </div>
        </div>
      ))}
      {page.nextToken && (
        <button
          onClick={() => {
            pages.current++;
            setRefresh((v) => v + 1);
          }}
        >
          {t('schedules.loadMore')}
        </button>
      )}
      {detail !== null && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
          {detail}
        </pre>
      )}
    </section>
  );
}
