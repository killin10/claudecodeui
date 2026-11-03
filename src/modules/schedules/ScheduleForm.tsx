import cronstrue from 'cronstrue';
import 'cronstrue/locales/zh_CN';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import type { Schedule } from '@/shared/types';
import { ScheduleSessionPicker } from '@/modules/schedules/ScheduleSessionPicker';

/** Schedule page owns saving; form retains drafts and previews without touching live task settings. */
export function ScheduleForm({
  task,
  initialSessionId,
  onSaved,
  onClose,
}: {
  task: Schedule | null;
  initialSessionId: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('common');
  const form = useRef<HTMLFormElement>(null);
  const createToken = useRef(crypto.randomUUID());
  // Timing mode decides which input is submitted; the inactive rule is explicitly cleared.
  const [mode, setMode] = useState(task?.runAt ? 'once' : 'cron');
  // Prevents duplicate mutations and shows the current save operation.
  const [busy, setBusy] = useState(false);
  // Keeps failures visible while preserving the user's draft.
  const [error, setError] = useState('');
  // Preview is invalidated when the draft changes and belongs only to the last requested rule.
  const [preview, setPreview] = useState<{
    times: string[];
    summary: string;
    timezone: string;
  } | null>(null);
  const previewGeneration = useRef(0);
  function timing(data: FormData) {
    const local = String(data.get('runAt') ?? '');
    return {
      cron: mode === 'cron' ? String(data.get('cron')) : null,
      runAt: mode === 'once' ? local.trim() : null,
      timezone: String(data.get('timezone')),
    };
  }
  async function showPreview() {
    const current = ++previewGeneration.current;
    try {
      const rule = timing(new FormData(form.current!));
      const result = await readApiJson<{ times: string[] }>(await api.schedules.preview(rule));
      const summary = rule.cron
        ? cronstrue.toString(rule.cron, {
            locale: i18n.language.startsWith('zh') ? 'zh_CN' : 'en',
            use24HourTimeFormat: true,
          })
        : rule.runAt!;
      if (current === previewGeneration.current) {
        setPreview({ times: result.times, summary, timezone: rule.timezone });
        setError('');
      }
    } catch (e) {
      if (current === previewGeneration.current) setError((e as Error).message);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const data = new FormData(form.current!);
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
      else
        await readApiJson(
          await api.schedules.create({
            ...body,
            sessionId: String(data.get('sessionId')),
            clientToken: createToken.current,
          }),
        );
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const input = 'w-full rounded border bg-background p-2';
  return (
    <form
      ref={form}
      onSubmit={(e) => void save(e)}
      onChange={() => {
        previewGeneration.current++;
        setPreview(null);
      }}
      className="space-y-4 rounded-lg border bg-card p-4"
      aria-label={t('schedules.form')}
    >
      <h2 className="text-lg font-medium">{t(task ? 'schedules.edit' : 'schedules.create')}</h2>
      <label className="block">
        {t('schedules.name')}
        <input name="name" required maxLength={200} defaultValue={task?.name} className={input} />
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
          rows={4}
          defaultValue={task?.message}
          className={input}
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
          <input
            name="timezone"
            required
            defaultValue={task?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
            className={input}
          />
        </label>
      </div>
      {mode === 'cron' ? (
        <label className="block">
          Cron
          <input
            name="cron"
            aria-label="Cron"
            required
            defaultValue={task?.cron ?? '0 9 * * 1-5'}
            className={input}
          />
          <span className="text-xs text-muted-foreground">{t('schedules.cronHelp')}</span>
        </label>
      ) : (
        <label className="block">
          {t('schedules.runAt')}
          <input
            name="runAt"
            type="text"
            required
            placeholder="2030-01-01T09:00:00+08:00"
            defaultValue={task?.runAt ?? ''}
            className={input}
          />
          <span className="text-xs text-muted-foreground">{t('schedules.onceHelp')}</span>
        </label>
      )}
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
            <input
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
                  {mode}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>
      <p className="text-xs text-muted-foreground">{t('schedules.behavior')}</p>
      <button
        type="button"
        className="rounded border px-3 py-1.5"
        onClick={() => void showPreview()}
      >
        {t('schedules.preview')}
      </button>
      {preview && (
        <div className="text-sm">
          <p>
            {preview.summary} · {preview.timezone}
          </p>
          {preview.times.length === 0 ? (
            <p>{t('schedules.noFuture')}</p>
          ) : (
            <ol>
              {preview.times.map((time) => (
                <li key={time}>
                  {new Date(time).toLocaleString(undefined, { timeZone: preview.timezone })} (
                  {preview.timezone})
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          disabled={busy}
          type="submit"
          className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
        >
          {t('schedules.save')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="rounded border px-4 py-2"
        >
          {t('schedules.close')}
        </button>
      </div>
    </form>
  );
}
