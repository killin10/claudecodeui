import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Clock, Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { Schedule } from '@/shared/types';
import { createClientToken } from '@/shared/utils';
import { ScheduleForm } from '@/modules/schedules/ScheduleForm';
import { ScheduleCard } from '@/modules/schedules/ScheduleCard';
import { useSchedules } from '@/modules/schedules/hooks/useSchedules';

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
  const runTokens = useRef(new Map<string, string>());
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
  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-sm text-foreground">
      <header className="pwa-header-safe flex shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background/95 px-3 py-1.5 sm:px-4 sm:py-2">
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
          {((!pendingDelete && error) || data.error) && (
            <p role="alert" className="text-destructive">
              {(!pendingDelete && error) || data.error}
            </p>
          )}
          {data.loading && <p>{t('schedules.loading')}</p>}
          {!data.loading && !data.error && data.items.length === 0 && (
            <p className="rounded border p-8 text-center text-muted-foreground">
              {t('schedules.empty')}
            </p>
          )}
          <div className="space-y-3">
            {data.items.map((task) => (
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
          className="top-[calc((100dvh-var(--keyboard-height,0px))/2)] flex max-h-[calc(100dvh-var(--keyboard-height,0px)-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-hidden p-0"
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
          <DialogTitle>{t('schedules.delete')}</DialogTitle>
          <h2 className="text-sm font-semibold">
            {t('schedules.delete')} · {pendingDelete?.name}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('schedules.deleteConfirm')}</p>
          {error && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
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
