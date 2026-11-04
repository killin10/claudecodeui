import { ArrowUpRight, Clock, History, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { Button } from '@/shared/ui';
import type { Schedule } from '@/shared/types';
import { ScheduleHistory } from '@/modules/schedules/ScheduleHistory';
import { ScheduleStatus } from '@/modules/schedules/ScheduleStatus';
import { ScheduleTime } from '@/modules/schedules/ScheduleTime';

/** SchedulesPage owns actions; this card groups the target, timing and execution history. */
export function ScheduleCard({
  task, busy, expanded, onEdit, onDelete, onAction, onHistory,
}: {
  task: Schedule;
  busy: boolean;
  expanded: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onAction: (action: 'pause' | 'resume' | 'run') => void;
  onHistory: () => void;
}) {
  const { t } = useTranslation('common');
  return (
    <article className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="break-words text-sm font-semibold">{task.name}</h2>
            <Link
              to={`/session/${encodeURIComponent(task.sessionId)}`}
              title={t('schedules.openSession')}
              className="inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="truncate">{task.sessionTitle || task.sessionId}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0" />
            </Link>
            <p className="truncate text-xs text-muted-foreground" title={task.projectPath ?? undefined}>
              {[task.provider, task.projectPath].filter(Boolean).join(' · ')}
            </p>
          </div>
          <ScheduleStatus enabled={task.enabled} />
        </div>
        <p className="line-clamp-3 whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {task.message}
        </p>
        <div className="grid gap-3 text-xs sm:grid-cols-2">
          <div className="space-y-1">
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {t('schedules.timing')}
            </p>
            <p>
              {task.cron ? <code>{task.cron}</code> : task.runAt && (
                <ScheduleTime value={task.runAt} timezone={task.timezone} />
              )}
            </p>
            <p className="text-muted-foreground">{task.timezone}</p>
          </div>
          <div className="space-y-1">
            <p className="text-muted-foreground">{t('schedules.next')}</p>
            <p className="font-medium">
              {task.nextRunAt ? <ScheduleTime value={task.nextRunAt} timezone={task.timezone} /> : '—'}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              {t('schedules.last')} <ScheduleStatus state={task.lastState} />
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-border/50 bg-muted/20 px-2 py-1.5">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
          <Pencil />{t('schedules.edit')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction(task.enabled ? 'pause' : 'resume')}>
          {task.enabled ? <Pause /> : <Play />}{t(task.enabled ? 'schedules.pause' : 'schedules.resume')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('run')}>
          <Play />{t('schedules.runNow')}
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={onHistory}>
          <History />{t('schedules.history')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} className="ml-auto text-destructive" onClick={onDelete}>
          <Trash2 />{t('schedules.delete')}
        </Button>
      </div>
      {expanded && (
        <div className="px-4 pb-4"><ScheduleHistory scheduleId={task.scheduleId} /></div>
      )}
    </article>
  );
}
