import { useTranslation } from 'react-i18next';

const STATUS_COLORS: Record<string, string> = {
  enabled: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  succeeded: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  paused: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  'waiting-for-input': 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  running: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  queued: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  failed: 'bg-destructive/10 text-destructive',
  interrupted: 'bg-destructive/10 text-destructive',
};

/** Schedule cards and history show status using both text and a colored dot. */
export function ScheduleStatus({ state, enabled }: { state?: string | null; enabled?: boolean }) {
  const { t } = useTranslation('common');
  const key = enabled === undefined ? state : enabled ? 'enabled' : 'paused';
  if (!key) return <span className="text-muted-foreground">—</span>;
  const label = enabled === undefined ? `schedules.states.${key}` : `schedules.${key}`;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[key] ?? 'bg-muted text-muted-foreground'}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {t(label, { defaultValue: key })}
    </span>
  );
}
