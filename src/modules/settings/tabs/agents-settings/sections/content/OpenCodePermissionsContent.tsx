import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useOpenCodePermissions } from '@/modules/settings/hooks/useOpenCodePermissions';
import type { AgentSettingsProject, OpenCodePermissionRule, OpenCodePermissionSettings } from '@/shared/types';
import { Button, Input } from '@/shared/ui';

function RuleList({ rules }: { rules: OpenCodePermissionRule[] }) {
  return <ul className="space-y-1 text-xs">
    {rules.map((rule, index) => <li key={index} className="break-all font-mono">{rule.action} · {rule.resource} → {rule.effect}</li>)}
  </ul>;
}

function RuleEditor({ filename, rules, busy, onChange, save }: {
  filename: string;
  rules: OpenCodePermissionRule[];
  busy: boolean;
  onChange(rules: OpenCodePermissionRule[]): void;
  save(): Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const update = (index: number, patch: Partial<OpenCodePermissionRule>) => {
    onChange(rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  };
  const move = (index: number, offset: number) => {
    const next = [...rules];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(next);
  };
  return (
    <section className="space-y-3">
      <h4 className="text-sm font-medium">{t('opencodePermissions.userRules', 'User rules')}</h4>
      <p className="break-all text-xs text-muted-foreground">{filename}</p>
      {rules.map((rule, index) => <div key={index} className="flex flex-wrap items-center gap-2 rounded border p-2">
        <Input
          aria-label={`${t('opencodePermissions.action', 'Action')} ${index + 1}`}
          value={rule.action} disabled={busy} className="min-w-24 flex-1"
          onChange={(event) => update(index, { action: event.target.value })}
        />
        <Input
          aria-label={`${t('opencodePermissions.resource', 'Resource')} ${index + 1}`}
          value={rule.resource} disabled={busy} className="min-w-32 flex-1"
          onChange={(event) => update(index, { resource: event.target.value })}
        />
        <select
          aria-label={`${t('opencodePermissions.effect', 'Effect')} ${index + 1}`}
          value={rule.effect} disabled={busy} className="rounded border bg-background p-2 text-sm"
          onChange={(event) => update(index, { effect: event.target.value as OpenCodePermissionRule['effect'] })}
        >
          {(['ask', 'allow', 'deny'] as const).map((effect) => <option key={effect} value={effect}>{effect}</option>)}
        </select>
        <Button size="sm" variant="outline" disabled={busy || index === 0}
          onClick={() => move(index, -1)} aria-label={`${t('opencodePermissions.up', 'Move up')} ${index + 1}`}>↑</Button>
        <Button size="sm" variant="outline" disabled={busy || index === rules.length - 1}
          onClick={() => move(index, 1)} aria-label={`${t('opencodePermissions.down', 'Move down')} ${index + 1}`}>↓</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onChange(rules.filter((_, i) => i !== index))}>
          {t('opencodePermissions.remove', 'Remove')}
        </Button>
      </div>)}
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy} onClick={() => onChange([...rules, { action: '', resource: '*', effect: 'ask' }])}>
          {t('opencodePermissions.add', 'Add rule')}
        </Button>
        <Button disabled={busy || rules.some((rule) => !rule.action.trim() || !rule.resource.trim())} onClick={() => void save()}>
          {t('opencodePermissions.save', 'Save user rules')}
        </Button>
      </div>
    </section>
  );
}

function RuleSources({ settings }: { settings: OpenCodePermissionSettings }) {
  const { t } = useTranslation('settings');
  return <>
    <section className="space-y-3">
      <h4 className="text-sm font-medium">{t('opencodePermissions.sources', 'Native configuration sources (read only)')}</h4>
      <p className="text-xs text-muted-foreground">{settings.directory}</p>
      {settings.sources.map((source, index) => <div key={index} className="space-y-2 rounded border p-3">
        <p className="break-all text-xs">{source.path || t('opencodePermissions.inline', 'Inline configuration')}</p>
        <RuleList rules={source.rules} />
        {source.agents.map((agent) => <div key={agent.name}><p className="text-xs font-medium">Agent: {agent.name}</p><RuleList rules={agent.rules} /></div>)}
      </div>)}
      {!settings.sources.length && <p className="text-sm text-muted-foreground">{t('opencodePermissions.empty', 'No configured rules for this directory.')}</p>}
    </section>
    <section className="space-y-2">
      <h4 className="text-sm font-medium">{t('opencodePermissions.saved', 'Saved project approvals (Always allow)')}</h4>
      <RuleList rules={settings.saved.map((rule) => ({ ...rule, effect: 'allow' }))} />
      {!settings.saved.length && <p className="text-sm text-muted-foreground">{t('opencodePermissions.noSaved', 'No saved approvals for this project.')}</p>}
    </section>
  </>;
}

/** Used by the OpenCode settings category to edit user rules and inspect native rules for a selected project. */
export function OpenCodePermissionsContent({ projects }: { projects: AgentSettingsProject[] }) {
  const { t } = useTranslation('settings');
  // A directory determines which project config and saved approvals OpenCode applies.
  const [workspacePath, setWorkspacePath] = useState('');
  const { settings, rules, setRules, status, error, reload, save } = useOpenCodePermissions(workspacePath);
  const busy = status !== 'ready';
  return <div className="space-y-5">
    <h3 className="font-medium">{t('opencodePermissions.title', 'OpenCode permissions')}</h3>
    <p className="text-sm text-muted-foreground">{t('opencodePermissions.description', 'Edit user rules shared by OpenCode sessions. Later matching rules take precedence; agent and session rules may also apply. Changes apply to new turns.')}</p>
    <label className="block space-y-1 text-sm">
      <span>{t('opencodePermissions.directory', 'Inspect rules for')}</span>
      <select aria-label={t('opencodePermissions.directory', 'Inspect rules for')} disabled={busy} value={workspacePath} onChange={(event) => {
        reload();
        setWorkspacePath(event.target.value);
      }} className="w-full rounded border bg-background p-2">
        <option value="">{t('opencodePermissions.home', 'Home directory')}</option>
        {projects.map((project) => <option key={project.name} value={project.fullPath || project.path}>{project.displayName || project.name}</option>)}
      </select>
    </label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {busy && <p role="status">{t('opencodePermissions.loading', 'Loading or saving…')}</p>}
    <Button variant="outline" disabled={busy} onClick={reload}>{t('opencodePermissions.reload', 'Reload')}</Button>
    {settings && <>
      <RuleEditor filename={settings.editable.path} rules={rules} busy={busy} onChange={setRules} save={save} />
      <RuleSources settings={settings} />
    </>}
  </div>;
}
