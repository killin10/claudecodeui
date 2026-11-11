import { ArrowUpRight, CalendarClock, History, MoreHorizontal, Pause, Pencil, Play, Repeat, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { ActionMenu, Button, LLMProviderLogo } from '@/shared/ui';
import type { Schedule } from '@/shared/types';
import { ScheduleHistory } from '@/modules/schedules/ScheduleHistory';
import { ScheduleStatus } from '@/modules/schedules/ScheduleStatus';
import { ScheduleTime } from '@/modules/schedules/ScheduleTime';
import { describeCron, isRunInProgress, scheduleTaskStatus } from '@/modules/schedules/utils/scheduleTiming';

/**
 * SchedulesPage owns actions; this card shows one task at a glance: name,
 * target, rule in words, next run and the latest result. Edit, history and
 * delete sit behind the overflow menu so the two common actions stay in front.
 */
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
  const { t, i18n } = useTranslation('common');
  const status = scheduleTaskStatus(task);
  const runBlocked = isRunInProgress(task.lastState);
  const ruleSummary = task.cron ? describeCron(task.cron, i18n.language) : null;

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-card/50">
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="break-words text-sm font-semibold text-foreground">{task.name}</h2>
              <ScheduleStatus kind="task" status={status} />
            </div>
            <Link
              to={`/session/${encodeURIComponent(task.sessionId)}`}
              title={t('schedules.openSession')}
              className="inline-flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {task.provider && <LLMProviderLogo provider={task.provider} className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate">{task.sessionTitle || task.sessionId}</span>
              {task.projectPath && <span className="hidden truncate text-muted-foreground/70 sm:inline">· {task.projectPath}</span>}
              <ArrowUpRight className="h-3 w-3 shrink-0" />
            </Link>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || runBlocked}
              title={runBlocked ? t('schedules.runNowBusy') : t('schedules.runNow')}
              onClick={() => onAction('run')}
            >
              <Play />
              <span className="hidden sm:inline">{t('schedules.runNow')}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title={t(task.enabled ? 'schedules.pause' : 'schedules.resume')}
              onClick={() => onAction(task.enabled ? 'pause' : 'resume')}
            >
              {task.enabled ? <Pause /> : <Play />}
              <span className="hidden sm:inline">{t(task.enabled ? 'schedules.pause' : 'schedules.resume')}</span>
            </Button>
            <ActionMenu
              label={t('schedules.more')}
              ariaLabel={t('schedules.more')}
              icon={MoreHorizontal}
              iconOnly
              // Rendered outside the card: its overflow clipping cut the menu off on short cards.
              portal
              variant="ghost"
              disabled={busy}
              triggerClassName="h-9 w-9 px-0"
              items={[
                { key: 'edit', label: t('schedules.edit'), icon: Pencil, onSelect: onEdit },
                { key: 'history', label: t('schedules.history'), icon: History, onSelect: onHistory },
                { key: 'delete', label: t('schedules.delete'), icon: Trash2, isDanger: true, showDividerBefore: true, onSelect: onDelete },
              ]}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Repeat className="h-3.5 w-3.5 shrink-0" />
            {task.cron ? (
              <span title={task.cron}>{ruleSummary}</span>
            ) : task.runAt && (
              <ScheduleTime value={task.runAt} timezone={task.timezone} />
            )}
            <span className="text-muted-foreground/70">· {task.timezone}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock className="h-3.5 w-3.5 shrink-0" />
            {t('schedules.next')}:{' '}
            {task.nextRunAt ? (
              <span className="font-medium text-foreground"><ScheduleTime value={task.nextRunAt} timezone={task.timezone} /></span>
            ) : '—'}
          </span>
          <span className="inline-flex items-center gap-1.5">
            {t('schedules.last')}: <ScheduleStatus kind="run" state={task.lastState} />
          </span>
        </div>

        <p className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground" title={task.message}>
          {task.message}
        </p>
      </div>
      {expanded && (
        <div className="border-t border-border/60 px-4 pb-4"><ScheduleHistory scheduleId={task.scheduleId} /></div>
      )}
    </article>
  );
}
