import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Clock, Plus, RefreshCw, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle, Input, Pill, PillBar, Shimmer } from '@/shared/ui';
import type { Schedule } from '@/shared/types';
import { createClientToken } from '@/shared/utils';
import { ScheduleForm } from '@/modules/schedules/ScheduleForm';
import { ScheduleCard } from '@/modules/schedules/ScheduleCard';
import { useSchedules } from '@/modules/schedules/hooks/useSchedules';
import { scheduleTaskStatus, type ScheduleTaskStatus } from '@/modules/schedules/utils/scheduleTiming';

type StatusFilter = 'all' | ScheduleTaskStatus;
const STATUS_FILTERS: StatusFilter[] = ['all', 'enabled', 'paused', 'completed'];

const STATUS_ORDER: Record<ScheduleTaskStatus, number> = { enabled: 0, paused: 1, completed: 2 };

/** Active tasks first, each status ordered by its next run, then by name; each card names its own session. */
const sortTasks = (tasks: Schedule[]): Schedule[] => [...tasks].sort((left, right) => (
  STATUS_ORDER[scheduleTaskStatus(left)] - STATUS_ORDER[scheduleTaskStatus(right)]
  || (left.nextRunAt ?? '\uffff').localeCompare(right.nextRunAt ?? '\uffff')
  || left.name.localeCompare(right.name)
));

/** ProjectMainRegion renders schedules in the workspace, retaining the sidebar and global controls. */
export function SchedulesPage({ mobileMenu }: { mobileMenu?: ReactNode }) {
  const { t } = useTranslation('common');
  const [params] = useSearchParams();
  const data = useSchedules();
  // An edit snapshots its revision so background refresh cannot silently replace an unsaved draft.
  const [editing, setEditing] = useState<Schedule | 'new' | null>(
    params.get('sessionId') ? 'new' : null,
  );
  // Keep the editor mounted while its save request is in flight.
  const [editorBusy, setEditorBusy] = useState(false);
  // Selected task controls the history view independently of the editor.
  const [historyId, setHistoryId] = useState<string | null>(null);
  // Mutation failures remain visible and do not erase successful list data.
  const [error, setError] = useState('');
  // Disables concurrent actions while the server applies a mutation.
  const [busy, setBusy] = useState(false);
  // Deletion uses the same themed dialog as the rest of the workspace.
  const [pendingDelete, setPendingDelete] = useState<Schedule | null>(null);
  // Free-text filter over task names, prompts and session titles; local to this page.
  const [search, setSearch] = useState('');
  // Which task statuses the list shows; `all` is the default so nothing is hidden by surprise.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const runTokens = useRef(new Map<string, string>());

  const tasks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const visible = data.items.filter((task) => (
      (statusFilter === 'all' || scheduleTaskStatus(task) === statusFilter)
      && (!needle || [task.name, task.message, task.sessionTitle ?? '', task.projectPath ?? ''].some((text) => text.toLowerCase().includes(needle)))
    ));
    return sortTasks(visible);
  }, [data.items, search, statusFilter]);
  const isFiltered = Boolean(search.trim()) || statusFilter !== 'all';

  async function action(task: Schedule, kind: 'pause' | 'resume' | 'run' | 'delete') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (kind === 'delete') {
        await readApiJson(await api.schedules.remove(task.scheduleId));
        setPendingDelete(null);
      } else {
        if (kind === 'run' && !runTokens.current.has(task.scheduleId))
          runTokens.current.set(task.scheduleId, createClientToken());
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

  const listError = (!pendingDelete && error) || data.error;

  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-sm text-foreground">
      <header className="pwa-header-safe flex shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background/95 px-3 py-1.5 backdrop-blur-sm sm:px-4 sm:py-2">
        <div className="flex min-w-0 items-center gap-2">
          {mobileMenu}
          <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-sm font-medium">{t('schedules.title')}</h1>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void data.refresh()}
            aria-label={t('schedules.refresh')}
            title={t('schedules.refresh')}
          >
            <RefreshCw />
          </Button>
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus />
            {t('schedules.create')}
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
        <div className="mx-auto max-w-5xl space-y-4">
          <p className="text-sm text-muted-foreground">{t('schedules.intro')}</p>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('schedules.filterPlaceholder')}
                aria-label={t('schedules.filterPlaceholder')}
                className="bg-background pl-9"
              />
            </div>
            <PillBar className="overflow-x-auto">
              {STATUS_FILTERS.map((filter) => (
                <Pill key={filter} isActive={statusFilter === filter} onClick={() => setStatusFilter(filter)}>
                  {t(`schedules.filters.${filter}`)}
                </Pill>
              ))}
            </PillBar>
          </div>

          {listError && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {listError}
            </p>
          )}
          {data.loading && (
            <p className="py-6 text-center text-sm"><Shimmer>{t('schedules.loading')}</Shimmer></p>
          )}
          {!data.loading && !data.error && data.items.length === 0 && (
            <div className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-4 py-10 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-border/60 bg-background/80 text-muted-foreground">
                <Clock className="h-5 w-5" />
              </div>
              <p className="mt-3 text-sm font-medium text-foreground">{t('schedules.empty')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('schedules.emptyHint')}</p>
              <Button size="sm" className="mt-4" onClick={() => setEditing('new')}>
                <Plus />
                {t('schedules.create')}
              </Button>
            </div>
          )}
          {!data.loading && data.items.length > 0 && tasks.length === 0 && isFiltered && (
            <p className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
              {t('schedules.noMatches')}
            </p>
          )}

          <div className="space-y-2">
            {tasks.map((task) => (
              <ScheduleCard
                key={task.scheduleId}
                task={task}
                busy={busy}
                expanded={historyId === task.scheduleId}
                onEdit={() => setEditing(task)}
                onAction={(kind) => void action(task, kind)}
                onHistory={() => setHistoryId(historyId === task.scheduleId ? null : task.scheduleId)}
                onDelete={() => {
                  setError('');
                  setPendingDelete(task);
                }}
              />
            ))}
          </div>
          {data.nextToken && (
            <Button size="sm" variant="ghost" className="w-full" onClick={() => void data.more()}>
              {t('schedules.loadMore')}
            </Button>
          )}
        </div>
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => {
        if (!open && !editorBusy) setEditing(null);
      }}>
        <DialogContent
          aria-label={t(editing === 'new' ? 'schedules.create' : 'schedules.edit')}
          className="top-[calc((100dvh-var(--keyboard-height,0px))/2)] flex max-h-[calc(100dvh-var(--keyboard-height,0px)-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-hidden"
        >
          {editing && (
            <ScheduleForm
              key={editing === 'new' ? 'new' : editing.scheduleId}
              task={editing === 'new' ? null : editing}
              initialSessionId={params.get('sessionId') ?? ''}
              onClose={() => setEditing(null)}
              onBusyChange={setEditorBusy}
              onSaved={() => {
                setEditing(null);
                void data.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingDelete(null);
        }}
      >
        <DialogContent className="max-w-sm p-5">
          <DialogTitle className="not-sr-only text-base font-semibold text-foreground">
            {t('schedules.delete')} · {pendingDelete?.name}
          </DialogTitle>
          <p className="mt-2 text-sm text-muted-foreground">{t('schedules.deleteConfirm')}</p>
          {error && (
            <p role="alert" className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setPendingDelete(null)}
            >
              {t('buttons.cancel')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => pendingDelete && void action(pendingDelete, 'delete')}
            >
              {t('schedules.delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
