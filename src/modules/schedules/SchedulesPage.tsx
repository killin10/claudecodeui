import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';

import { api, readApiJson } from '@/shared/api';
import type { Schedule } from '@/shared/types';
import { ScheduleForm } from '@/modules/schedules/ScheduleForm';
import { ScheduleHistory } from '@/modules/schedules/ScheduleHistory';
import { useSchedules } from '@/modules/schedules/hooks/useSchedules';

/** App route displays the built-in scheduler across all projects; no plugin or open chat is required. */
export function SchedulesPage() {
  const { t } = useTranslation('common');
  const [params] = useSearchParams();
  const data = useSchedules();
  // An edit snapshots its revision so background refresh cannot silently replace an unsaved draft.
  const [editing, setEditing] = useState<Schedule | 'new' | null>(
    params.get('sessionId') ? 'new' : null,
  );
  // Selected task controls the history view independently of the editor.
  const [historyId, setHistoryId] = useState<string | null>(null);
  // Mutation failures remain visible and do not erase successful list data.
  const [error, setError] = useState('');
  // Disables concurrent actions while the server applies a mutation.
  const [busy, setBusy] = useState(false);
  const runTokens = useRef(new Map<string, string>());
  async function action(task: Schedule, kind: 'pause' | 'resume' | 'run' | 'delete') {
    if (busy) return;
    if (kind === 'delete' && !window.confirm(t('schedules.deleteConfirm'))) return;
    setBusy(true);
    setError('');
    try {
      if (kind === 'delete') await readApiJson(await api.schedules.remove(task.scheduleId));
      else {
        if (kind === 'run' && !runTokens.current.has(task.scheduleId))
          runTokens.current.set(task.scheduleId, crypto.randomUUID());
        await readApiJson(
          await api.schedules.action(
            task.scheduleId,
            kind,
            kind === 'run' ? { clientToken: runTokens.current.get(task.scheduleId) } : {},
          ),
        );
        if (kind === 'run') {
          runTokens.current.delete(task.scheduleId);
          setHistoryId(task.scheduleId);
        }
      }
      await data.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="h-dvh overflow-auto bg-background p-4 text-foreground sm:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link to="/" className="text-sm text-muted-foreground">
              ← {t('schedules.back')}
            </Link>
            <h1 className="text-2xl font-semibold">{t('schedules.title')}</h1>
          </div>
          <div className="flex gap-2">
            <button className="rounded border px-3 py-2" onClick={() => void data.refresh()}>
              {t('schedules.refresh')}
            </button>
            <button
              className="rounded bg-primary px-3 py-2 text-primary-foreground"
              onClick={() => setEditing('new')}
            >
              {t('schedules.create')}
            </button>
          </div>
        </header>
        <p className="text-sm text-muted-foreground">{t('schedules.intro')}</p>
        {(error || data.error) && (
          <p role="alert" className="text-destructive">
            {error || data.error}
          </p>
        )}
        {editing && (
          <ScheduleForm
            key={editing === 'new' ? 'new' : editing.scheduleId}
            task={editing === 'new' ? null : editing}
            initialSessionId={params.get('sessionId') ?? ''}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              void data.refresh();
            }}
          />
        )}
        {data.loading && <p>{t('schedules.loading')}</p>}
        {!data.loading && !data.error && data.items.length === 0 && (
          <p className="rounded border p-8 text-center text-muted-foreground">
            {t('schedules.empty')}
          </p>
        )}
        <div className="space-y-3">
          {data.items.map((task) => (
            <article key={task.scheduleId} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <h2 className="font-medium">{task.name}</h2>
                <span className="text-sm">
                  {t(task.enabled ? 'schedules.enabled' : 'schedules.paused')}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {task.sessionTitle || task.sessionId} · {task.provider} · {task.projectPath}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {task.cron ?? task.runAt} · {task.timezone}
              </p>
              <p className="mt-1 text-sm">
                {t('schedules.next')}:{' '}
                {task.nextRunAt
                  ? new Date(task.nextRunAt).toLocaleString(undefined, { timeZone: task.timezone })
                  : '—'}{' '}
                {task.nextRunAt && task.timezone}
              </p>
              <p className="mt-1 text-sm">
                {t('schedules.last')}:{' '}
                {task.lastState
                  ? t(`schedules.states.${task.lastState}`, { defaultValue: task.lastState })
                  : '—'}
              </p>
              <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">
                {task.message}
              </p>
              <div className="mt-3 flex flex-wrap gap-4 text-sm">
                <Link
                  to={`/session/${encodeURIComponent(task.sessionId)}`}
                  className="text-primary underline"
                >
                  {t('schedules.openSession')}
                </Link>
                <button disabled={busy} onClick={() => setEditing(task)}>
                  {t('schedules.edit')}
                </button>
                <button
                  disabled={busy}
                  onClick={() => void action(task, task.enabled ? 'pause' : 'resume')}
                >
                  {t(task.enabled ? 'schedules.pause' : 'schedules.resume')}
                </button>
                <button disabled={busy} onClick={() => void action(task, 'run')}>
                  {t('schedules.runNow')}
                </button>
                <button
                  onClick={() =>
                    setHistoryId(historyId === task.scheduleId ? null : task.scheduleId)
                  }
                >
                  {t('schedules.history')}
                </button>
                <button
                  disabled={busy}
                  className="text-destructive"
                  onClick={() => void action(task, 'delete')}
                >
                  {t('schedules.delete')}
                </button>
              </div>
              {historyId === task.scheduleId && (
                <ScheduleHistory key={task.scheduleId} scheduleId={task.scheduleId} />
              )}
            </article>
          ))}
        </div>
        {data.nextToken && (
          <button className="rounded border px-3 py-2" onClick={() => void data.more()}>
            {t('schedules.loadMore')}
          </button>
        )}
      </div>
    </main>
  );
}
