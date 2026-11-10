import { useTranslation } from 'react-i18next';

import { Badge } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { ScheduleTaskStatus } from '@/modules/schedules/utils/scheduleTiming';

const TASK_STATUS_CLASSES: Record<ScheduleTaskStatus, string> = {
  enabled: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
  paused: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  completed: 'border-border text-muted-foreground',
};

const RUN_STATE_CLASSES: Record<string, string> = {
  succeeded: 'text-emerald-700 dark:text-emerald-400',
  'waiting-for-input': 'text-amber-700 dark:text-amber-400',
  running: 'text-blue-700 dark:text-blue-400',
  queued: 'text-blue-700 dark:text-blue-400',
  failed: 'text-destructive',
  interrupted: 'text-destructive',
};

type ScheduleStatusProps =
  | { kind: 'task'; status: ScheduleTaskStatus }
  | { kind: 'run'; state: string | null | undefined };

/**
 * Schedule cards and history show two different things with two different
 * looks: a task's status as an outlined badge with a dot, and a run's state as
 * a plain tinted label, so the two are never read as the same thing.
 */
export function ScheduleStatus(props: ScheduleStatusProps) {
  const { t } = useTranslation('common');
  if (props.kind === 'task') {
    return (
      <Badge variant="outline" className={cn('gap-1.5 rounded-full px-2 py-0.5 font-medium', TASK_STATUS_CLASSES[props.status])}>
        <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full bg-current', props.status === 'enabled' && 'animate-pulse')} />
        {t(`schedules.${props.status}`)}
      </Badge>
    );
  }
  if (!props.state) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <span className={cn('text-xs font-medium', RUN_STATE_CLASSES[props.state] ?? 'text-muted-foreground')}>
      {t(`schedules.states.${props.state}`, { defaultValue: props.state })}
    </span>
  );
}
