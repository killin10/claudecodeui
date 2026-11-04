import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { api, readApiJson } from '@/shared/api';
import { Button } from '@/shared/ui';
import type { ScheduleRun } from '@/shared/types';
import { ScheduleTime } from '@/modules/schedules/ScheduleTime';
import { ScheduleStatus } from '@/modules/schedules/ScheduleStatus';
import { ScheduleRunResult } from '@/modules/schedules/ScheduleRunResult';

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
  // Only the selected execution expands its output directly beneath that record.
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  // A reload request follows load-more or cancellation, while polling also observes external changes.
  const [refresh, setRefresh] = useState(0);
  // Prevents simultaneous cancel actions in this history view.
  const [busy, setBusy] = useState(false);
  const pages = useRef(1);
  useEffect(() => {
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
    };
  }, [scheduleId, refresh]);
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
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t('schedules.history')}</h3>
        <p className="text-xs text-muted-foreground">{t('schedules.historyRetention')}</p>
      </div>
      {(error || fetchError) && (
        <p role="alert" className="text-destructive">
          {error || fetchError}
        </p>
      )}
      {page.items.map((run) => (
        <div key={run.runId} className="space-y-1 border-b py-2 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <ScheduleTime value={run.scheduledFor} timezone={run.snapshot.timezone} />
            <span className="text-xs text-muted-foreground">{run.snapshot.timezone}</span>
            <ScheduleStatus state={run.state} />
            <span>{t(`schedules.${run.source}`)}</span>
          </div>
          {run.reason && <p className="break-words text-muted-foreground">{run.reason}</p>}
          <div className="flex items-center gap-1">
            <Link
              className="text-primary underline"
              to={`/session/${encodeURIComponent(run.sessionId)}`}
            >
              {t('schedules.openSession')}
            </Link>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={expandedRunId === run.runId}
              onClick={() => setExpandedRunId(expandedRunId === run.runId ? null : run.runId)}
            >
              {t(expandedRunId === run.runId ? 'schedules.collapseResult' : 'schedules.result')}
            </Button>
            {['queued', 'running', 'waiting-for-input'].includes(run.state) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                className="text-destructive"
                onClick={() => void cancel(run)}
              >
                {t('schedules.cancelRun')}
              </Button>
            )}
          </div>
          {expandedRunId === run.runId && (
            <ScheduleRunResult key={`${scheduleId}:${run.runId}`} scheduleId={scheduleId} runId={run.runId} />
          )}
        </div>
      ))}
      {page.nextToken && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            pages.current++;
            setRefresh((v) => v + 1);
          }}
        >
          {t('schedules.loadMore')}
        </Button>
      )}
    </section>
  );
}
