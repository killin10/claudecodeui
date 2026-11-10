import { ChevronDown } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { loadCapabilities } from '@/shared/hooks/useProviderCapabilities';
import type { LLMProvider, ProviderModelOption, Schedule, ScheduleTargetSession } from '@/shared/types';
import { cn, createClientToken } from '@/shared/utils';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Input, Pill, PillBar } from '@/shared/ui';
import { SchedulePreview } from '@/modules/schedules/SchedulePreview';
import { ScheduleSessionPicker } from '@/modules/schedules/ScheduleSessionPicker';
import {
  COMMON_TIME_ZONES,
  CRON_PRESETS,
  cronPresetOf,
  listTimeZones,
  localTimeZone,
  quickRunAtValues,
  toZonedInputValue,
  zonedInputValueToIso,
} from '@/modules/schedules/utils/scheduleTiming';

/** The schedule API's permission-mode spelling for each value a provider reports in its own spelling. */
const PERMISSION_MODE_ALIASES: Record<string, string> = {
  default: 'default',
  auto: 'auto',
  plan: 'plan',
  acceptEdits: 'accept-edits',
  bypassPermissions: 'bypass-permissions',
};
const PERMISSION_MODES = ['default', 'auto', 'plan', 'accept-edits', 'bypass-permissions'];

const CONTROL_CLASSES =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

// The full list runs to several hundred zones, so it is rendered only once the
// picker is opened; until then the common zones plus the current one suffice.
// Memoised so typing elsewhere in the form never rebuilds the options.
const TimeZoneSelect = memo(function TimeZoneSelect({
  id, name, value, zones, onChange, className,
}: { id: string; name: string; value: string; zones: string[]; onChange: (zone: string) => void; className: string }) {
  // Whether the user has opened the picker, which is when the full list is worth rendering.
  const [showAll, setShowAll] = useState(false);
  const shown = useMemo(() => (
    showAll ? zones : [...new Set([...COMMON_TIME_ZONES, value])].sort((left, right) => left.localeCompare(right))
  ), [showAll, value, zones]);
  const expand = () => setShowAll(true);
  return (
    <select
      id={id}
      name={name}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onFocus={expand}
      onMouseDown={expand}
      className={className}
    >
      {shown.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
    </select>
  );
});

function Field({ id, label, hint, children }: { id?: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-foreground/80">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

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
  // Timing mode decides which rule is submitted; the inactive rule is explicitly cleared.
  const [mode, setMode] = useState<'cron' | 'once'>(task?.runAt ? 'once' : 'cron');
  // Prevents duplicate mutations and shows the current save operation.
  const [busy, setBusy] = useState(false);
  // Keeps failures visible while preserving the user's draft.
  const [error, setError] = useState('');
  // Time zone edits must recompute the same rule on the server.
  const [timezone, setTimezone] = useState(task?.timezone ?? localTimeZone());
  // Timing drafts drive automatic preview independently of unrelated form fields.
  const [cron, setCron] = useState(task?.cron ?? CRON_PRESETS[0].cron);
  // The one-time draft is the wall-clock time in the chosen zone, as the picker shows it.
  const [runAtLocal, setRunAtLocal] = useState(task?.runAt ? toZonedInputValue(task.runAt, task.timezone) : '');
  // The target session, so the model and permission pickers can follow its provider.
  const [session, setSession] = useState<ScheduleTargetSession | null>(null);
  // The model catalog of the provider it was read for; a text field stands in until it is known or when it could not be read.
  const [modelCatalog, setModelCatalog] = useState<{ provider: LLMProvider; options: ProviderModelOption[] } | null>(null);
  // Permission modes the target provider accepts; null until known, when every mode is offered.
  const [allowedModes, setAllowedModes] = useState<Set<string> | null>(null);

  const timeZones = useMemo(() => listTimeZones(timezone, task?.timezone ?? ''), [task?.timezone, timezone]);
  const preset = cronPresetOf(cron);
  const runAtIso = mode === 'once' ? zonedInputValueToIso(runAtLocal, timezone) : null;
  const quickTimes = useMemo(() => quickRunAtValues(timezone), [timezone]);

  const provider = session?.provider as LLMProvider | undefined;
  const projectPath = session?.projectPath ?? undefined;
  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.providers.models(provider, projectPath))
      .then(readApiJson<{ data?: { models?: { OPTIONS?: ProviderModelOption[] } } }>)
      .then((body) => {
        const options = body.data?.models?.OPTIONS;
        if (!cancelled && options) setModelCatalog({ provider, options });
      })
      .catch(() => {
        // The text field below still accepts any model id the server validates.
      });
    void loadCapabilities().then((capabilities) => {
      if (cancelled) return;
      const modes = capabilities[provider]?.permissionModes;
      setAllowedModes(modes ? new Set(modes.map((value) => PERMISSION_MODE_ALIASES[value] ?? value)) : null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath, provider]);

  const permissionModes = PERMISSION_MODES.filter((value) => !allowedModes || allowedModes.has(value) || value === task?.permissionMode);
  const modelOptions = modelCatalog && modelCatalog.provider === provider ? modelCatalog.options : null;
  // A saved model outside the catalog stays selectable, so an edit never silently drops it.
  const modelChoices = modelOptions && task?.model && !modelOptions.some((option) => option.value === task.model)
    ? [{ value: task.model, label: task.model }, ...modelOptions]
    : modelOptions;

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
      if (mode === 'once' && !runAtIso) {
        throw new Error(t('schedules.runAtInvalid'));
      }
      const body = {
        name: String(data.get('name')),
        message: String(data.get('message')),
        cron: mode === 'cron' ? cron : null,
        runAt: mode === 'once' ? runAtIso : null,
        timezone,
        misfirePolicy: mode === 'cron' ? String(data.get('misfirePolicy') ?? 'skip') : 'skip',
        model: String(data.get('model') ?? '').trim() || null,
        permissionMode: String(data.get('permissionMode') ?? '') || null,
      };
      if (task) {
        await readApiJson(
          await api.schedules.update(task.scheduleId, { ...body, revision: task.revision }),
        );
      } else {
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

  return (
    <form
      ref={form}
      onSubmit={(e) => void save(e)}
      className="flex min-h-0 w-full flex-col text-sm"
      aria-label={t('schedules.form')}
    >
      <h2 className="shrink-0 border-b border-border/60 px-5 py-4 text-base font-semibold text-foreground">
        {t(task ? 'schedules.edit' : 'schedules.create')}
      </h2>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-5">
        <Field id="schedule-name" label={t('schedules.name')}>
          <Input id="schedule-name" name="name" required maxLength={200} defaultValue={task?.name} className="bg-background" />
        </Field>

        <Field label={t('schedules.session')}>
          <ScheduleSessionPicker
            initialId={task?.sessionId ?? initialSessionId}
            disabled={Boolean(task)}
            onChange={setSession}
          />
        </Field>

        <Field id="schedule-message" label={t('schedules.message')}>
          <textarea
            id="schedule-message"
            name="message"
            required
            maxLength={1000000}
            rows={6}
            defaultValue={task?.message}
            className={cn(CONTROL_CLASSES, 'h-36 min-h-24 resize-y py-2')}
          />
        </Field>

        <div className="space-y-3 rounded-lg border border-border/60 bg-muted/15 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-foreground/80">{t('schedules.timing')}</span>
            <PillBar>
              <Pill isActive={mode === 'cron'} onClick={() => setMode('cron')}>{t('schedules.recurring')}</Pill>
              <Pill isActive={mode === 'once'} onClick={() => setMode('once')}>{t('schedules.once')}</Pill>
            </PillBar>
          </div>

          {mode === 'cron' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="schedule-preset" label={t('schedules.preset')}>
                <select
                  id="schedule-preset"
                  value={preset}
                  onChange={(event) => {
                    const chosen = CRON_PRESETS.find((entry) => entry.key === event.target.value);
                    if (chosen) setCron(chosen.cron);
                  }}
                  className={CONTROL_CLASSES}
                >
                  {CRON_PRESETS.map((entry) => (
                    <option key={entry.key} value={entry.key}>{t(`schedules.presets.${entry.key}`)}</option>
                  ))}
                  <option value="custom">{t('schedules.presets.custom')}</option>
                </select>
              </Field>
              <Field id="schedule-cron" label="Cron" hint={t('schedules.cronHelp')}>
                <Input
                  id="schedule-cron"
                  name="cron"
                  required
                  value={cron}
                  onChange={(event) => setCron(event.target.value)}
                  className="bg-background font-mono"
                />
              </Field>
            </div>
          ) : (
            <Field id="schedule-run-at" label={t('schedules.runAt')} hint={t('schedules.onceHelp')}>
              <Input
                id="schedule-run-at"
                type="datetime-local"
                required
                value={runAtLocal}
                onChange={(event) => setRunAtLocal(event.target.value)}
                className="bg-background"
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {quickTimes.map((quick) => (
                  <button
                    key={quick.key}
                    type="button"
                    onClick={() => setRunAtLocal(quick.value)}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                      runAtLocal === quick.value
                        ? 'border-primary/60 bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
                    )}
                  >
                    {t(`schedules.quick.${quick.key}`)}
                  </button>
                ))}
              </div>
            </Field>
          )}

          <Field id="schedule-timezone" label={t('schedules.timezone')}>
            <TimeZoneSelect
              id="schedule-timezone"
              name="timezone"
              value={timezone}
              zones={timeZones}
              onChange={setTimezone}
              className={CONTROL_CLASSES}
            />
          </Field>

          {(mode === 'cron' || runAtIso) ? (
            <SchedulePreview
              key={JSON.stringify([mode, mode === 'cron' ? cron : runAtIso, timezone])}
              cron={mode === 'cron' ? cron : null}
              runAt={runAtIso}
              timezone={timezone}
            />
          ) : (
            <p className="text-xs text-muted-foreground">{t('schedules.runAtInvalid')}</p>
          )}

          {mode === 'cron' && (
            <Field id="schedule-misfire" label={t('schedules.misfire')}>
              <select id="schedule-misfire" name="misfirePolicy" defaultValue={task?.misfirePolicy ?? 'skip'} className={CONTROL_CLASSES}>
                <option value="skip">{t('schedules.skip')}</option>
                <option value="latest">{t('schedules.latest')}</option>
              </select>
            </Field>
          )}
        </div>

        <Collapsible defaultOpen={Boolean(task?.model || task?.permissionMode)}>
          <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-md py-1 text-sm font-medium text-foreground/80 hover:text-foreground">
            <span>{t('schedules.overrides')}</span>
            <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="grid gap-3 pt-2 sm:grid-cols-2">
              <Field id="schedule-model" label={t('schedules.model')}>
                {modelChoices ? (
                  <select id="schedule-model" name="model" defaultValue={task?.model ?? ''} className={CONTROL_CLASSES}>
                    <option value="">{t('schedules.inherit')}</option>
                    {modelChoices.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id="schedule-model"
                    name="model"
                    defaultValue={task?.model ?? ''}
                    placeholder={t('schedules.inherit')}
                    className="bg-background"
                  />
                )}
              </Field>
              <Field id="schedule-permission" label={t('schedules.permission')}>
                <select id="schedule-permission" name="permissionMode" defaultValue={task?.permissionMode ?? ''} className={CONTROL_CLASSES}>
                  <option value="">{t('schedules.inherit')}</option>
                  {permissionModes.map((value) => (
                    <option key={value} value={value}>{t(`schedules.modes.${value}`)}</option>
                  ))}
                </select>
              </Field>
            </div>
            <p className="pt-3 text-xs text-muted-foreground">{t('schedules.behavior')}</p>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <div className="shrink-0 space-y-2 border-t border-border/60 px-5 py-3">
        {error && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" type="button" disabled={busy} onClick={onClose} variant="outline">
            {t('schedules.close')}
          </Button>
          <Button size="sm" disabled={busy} type="submit">
            {busy ? t('schedules.saving') : t('schedules.save')}
          </Button>
        </div>
      </div>
    </form>
  );
}
