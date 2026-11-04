import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import type { Schedule } from '@/shared/types';
import { cn, createClientToken } from '@/shared/utils';
import { Button, Input } from '@/shared/ui';
import { SchedulePreview } from '@/modules/schedules/SchedulePreview';
import { ScheduleSessionPicker } from '@/modules/schedules/ScheduleSessionPicker';

/** Used by SchedulesPage inside its editor dialog; retains drafts and previews until saving succeeds. */
export function ScheduleForm({
  task,
  initialSessionId,
  onSaved,
  onClose,
  onBusyChange,
}: {
  task: Schedule | null;
  initialSessionId: string;
  onSaved: () => void;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation('common');
  const form = useRef<HTMLFormElement>(null);
  const createToken = useRef<string | null>(null);
  // Timing mode decides which input is submitted; the inactive rule is explicitly cleared.
  const [mode, setMode] = useState(task?.runAt ? 'once' : 'cron');
  // Prevents duplicate mutations and shows the current save operation.
  const [busy, setBusy] = useState(false);
  // Keeps failures visible while preserving the user's draft.
  const [error, setError] = useState('');
  // Timing drafts drive automatic preview independently of unrelated form fields.
  const [cron, setCron] = useState(task?.cron ?? '0 9 * * 1-5');
  // A one-time draft is retained when switching between timing modes.
  const [runAt, setRunAt] = useState(task?.runAt ?? '');
  // Time zone edits must recompute the same rule on the server.
  const [timezone, setTimezone] = useState(
    task?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  function timing(data: FormData) {
    const local = String(data.get('runAt') ?? '');
    return {
      cron: mode === 'cron' ? String(data.get('cron')) : null,
      runAt: mode === 'once' ? local.trim() : null,
      timezone: String(data.get('timezone')),
    };
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      const data = new FormData(form.current!);
      if (!task && !String(data.get('sessionId') ?? '').trim()) {
        throw new Error(t('schedules.chooseSession'));
      }
      const body = {
        name: String(data.get('name')),
        message: String(data.get('message')),
        ...timing(data),
        misfirePolicy: String(data.get('misfirePolicy')),
        model: String(data.get('model') ?? '').trim() || null,
        permissionMode: String(data.get('permissionMode') ?? '') || null,
      };
      if (task)
        await readApiJson(
          await api.schedules.update(task.scheduleId, { ...body, revision: task.revision }),
        );
      else {
        createToken.current ??= createClientToken();
        await readApiJson(
          await api.schedules.create({
            ...body,
            sessionId: String(data.get('sessionId')),
            clientToken: createToken.current,
          }),
        );
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  const input =
    'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50';
  return (
    <form
      ref={form}
      onSubmit={(e) => void save(e)}
      className="flex min-h-0 w-full flex-col bg-card text-sm"
      aria-label={t('schedules.form')}
    >
      <h2 className="shrink-0 border-b border-border/60 px-4 py-3 text-sm font-semibold">{t(task ? 'schedules.edit' : 'schedules.create')}</h2>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
        <label className="block">
          {t('schedules.name')}
          <Input name="name" required maxLength={200} defaultValue={task?.name} className={input} />
        </label>
        <label className="block">{t('schedules.session')}</label>
        <ScheduleSessionPicker
          initialId={task?.sessionId ?? initialSessionId}
          disabled={Boolean(task)}
        />
        <label className="block">
          {t('schedules.message')}
          <textarea
            name="message"
            required
            maxLength={1000000}
            rows={8}
            defaultValue={task?.message}
            className={cn(input, 'h-48 min-h-48 resize-y py-2')}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            {t('schedules.timing')}
            <select value={mode} onChange={(e) => setMode(e.target.value)} className={input}>
              <option value="cron">Cron</option>
              <option value="once">{t('schedules.once')}</option>
            </select>
          </label>
          <label>
            {t('schedules.timezone')}
            <Input
              name="timezone"
              required
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              className={input}
            />
          </label>
        </div>
        {mode === 'cron' ? (
          <label className="block">
            Cron
            <Input
              name="cron"
              aria-label="Cron"
              required
              value={cron}
              onChange={(event) => setCron(event.target.value)}
              className={input}
            />
            <span className="text-xs text-muted-foreground">{t('schedules.cronHelp')}</span>
          </label>
        ) : (
          <label className="block">
            {t('schedules.runAt')}
            <Input
              name="runAt"
              type="text"
              required
              placeholder="2030-01-01T09:00:00+08:00"
              value={runAt}
              onChange={(event) => setRunAt(event.target.value)}
              className={input}
            />
            <span className="text-xs text-muted-foreground">{t('schedules.onceHelp')}</span>
          </label>
        )}
        <SchedulePreview
          key={JSON.stringify([mode, mode === 'cron' ? cron : runAt, timezone])}
          cron={mode === 'cron' ? cron : null}
          runAt={mode === 'once' ? runAt : null}
          timezone={timezone}
        />
        <label className="block">
          {t('schedules.misfire')}
          <select name="misfirePolicy" defaultValue={task?.misfirePolicy ?? 'skip'} className={input}>
            <option value="skip">{t('schedules.skip')}</option>
            <option value="latest">{t('schedules.latest')}</option>
          </select>
        </label>
        <details>
          <summary className="cursor-pointer">{t('schedules.overrides')}</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label>
              {t('schedules.model')}
              <Input
                name="model"
                defaultValue={task?.model ?? ''}
                placeholder={t('schedules.inherit')}
                className={input}
              />
            </label>
            <label>
              {t('schedules.permission')}
              <select
                name="permissionMode"
                defaultValue={task?.permissionMode ?? ''}
                className={input}
              >
                <option value="">{t('schedules.inherit')}</option>
                {['default', 'auto', 'plan', 'accept-edits', 'bypass-permissions'].map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`schedules.modes.${mode}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
        <p className="text-xs text-muted-foreground">{t('schedules.behavior')}</p>
      </div>
      <div className="shrink-0 space-y-2 border-t border-border/60 bg-card px-4 py-3">
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" disabled={busy} type="submit">
            {t('schedules.save')}
          </Button>
          <Button size="sm" type="button" disabled={busy} onClick={onClose} variant="outline">
            {t('schedules.close')}
          </Button>
        </div>
      </div>
    </form>
  );
}
