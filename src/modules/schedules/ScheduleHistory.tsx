import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { api, readApiJson } from '@/shared/api';
import { useOptionalWebSocket } from '@/shared/context/WebSocketContext';
import { Badge, Button, Shimmer } from '@/shared/ui';
import type { ScheduleRun, ServerEvent } from '@/shared/types';
import { ScheduleTime } from '@/modules/schedules/ScheduleTime';
import { ScheduleStatus } from '@/modules/schedules/ScheduleStatus';
import { isRunInProgress } from '@/modules/schedules/utils/scheduleTiming';

const REFRESH_KINDS = new Set(['schedules_changed', 'session_submission_changed', 'websocket_reconnected']);

/** Task history lists each run's state and failure reason; the reply itself is read in the session. */
export function ScheduleHistory({ scheduleId }: { scheduleId: string }) {
  const { t } = useTranslation('common');
  // The loaded history pages are refreshed together so pagination never silently drops older rows.
  const [page, setPage] = useState<{ items: ScheduleRun[]; nextToken: string | null } | null>(null);
  // Errors preserve existing history and remain distinguishable from a valid empty history.
  const [error, setError] = useState('');
  // Fetch failures and action failures have separate lifetimes: a refresh must not clear a cancellation error.
  const [fetchError, setFetchError] = useState('');
  // A reload request follows load-more, cancellation or a realtime change.
  const [refresh, setRefresh] = useState(0);
  // Prevents simultaneous cancel actions in this history view.
  const [busy, setBusy] = useState(false);
  const pages = useRef(1);
  const socket = useOptionalWebSocket();
  const subscribe = socket?.subscribe;

  useEffect(() => {
    let disposed = false;
    async function load() {
      try {
        let nextToken: string | null = null;
        const items: ScheduleRun[] = [];
        for (let i = 0; i < pages.current; i++) {
          const result: NonNullable<typeof page> = await readApiJson(
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
    }
    void load();
    // Run progress normally arrives over the socket; this covers a frame lost while it was down.
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [scheduleId, refresh]);

  useEffect(() => {
    if (!subscribe) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe((event: ServerEvent) => {
      if (!REFRESH_KINDS.has(String(event.kind)) || pending) return;
      pending = setTimeout(() => {
        pending = null;
        setRefresh((value) => value + 1);
      }, 150);
    });
    return () => {
      unsubscribe();
      if (pending) clearTimeout(pending);
    };
  }, [subscribe]);

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
    <section className="mt-4 space-y-3" aria-label={t('schedules.history')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{t('schedules.history')}</h3>
        <p className="text-xs text-muted-foreground">{t('schedules.historyRetention')}</p>
      </div>
      {(error || fetchError) && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error || fetchError}
        </p>
      )}
      {!page && !fetchError && (
        <p className="text-xs"><Shimmer>{t('schedules.loading')}</Shimmer></p>
      )}
      {page && page.items.length === 0 && (
        <p className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-4 py-6 text-center text-xs text-muted-foreground">
          {t('schedules.noRuns')}
        </p>
      )}
      <div className="space-y-2">
        {page?.items.map((run) => (
          <div key={run.runId} className="space-y-1.5 rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <ScheduleTime value={run.scheduledFor} timezone={run.snapshot.timezone} />
              <span className="text-xs text-muted-foreground">{run.snapshot.timezone}</span>
              <ScheduleStatus kind="run" state={run.state} />
              <Badge variant="secondary" className="px-1.5 py-0 text-[11px] font-medium">{t(`schedules.${run.source}`)}</Badge>
            </div>
            {run.reason && <p className="break-words text-xs text-muted-foreground">{run.reason}</p>}
            <div className="flex flex-wrap items-center gap-1">
              <Link
                className="px-2 text-xs text-primary hover:underline"
                to={`/session/${encodeURIComponent(run.sessionId)}`}
              >
                {t('schedules.openSession')}
              </Link>
              {isRunInProgress(run.state) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                  onClick={() => void cancel(run)}
                >
                  {t('schedules.cancelRun')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {page?.nextToken && (
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
