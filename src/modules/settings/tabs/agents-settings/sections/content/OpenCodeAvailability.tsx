import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import type { AgentSettingsProject } from '@/shared/types';
import { Button } from '@/shared/ui';

/** AccountContent checks native model availability separately from saved account credentials. */
export function OpenCodeAvailability({ projects }: { projects: AgentSettingsProject[] }) {
  const { t } = useTranslation('settings');
  // Availability belongs to the directory selected in this account panel.
  const [directory, setDirectory] = useState('');
  // An explicit retry refreshes a failed check without changing the selected project.
  const [revision, setRevision] = useState(0);
  // Tag results with their request scope so navigation never shows another project's answer.
  const [result, setResult] = useState<{ scope: string; count: number | null; error?: string } | null>(null);
  const scope = `${directory}:${revision}`;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.providers.authStatus('opencode', directory);
        const body = await response.json();
        const availability = body.data?.projectAvailability;
        if (!response.ok || !body.success || !availability
          || !(availability.modelCount === null ? typeof availability.error === 'string' && availability.error.length > 0
            : Number.isInteger(availability.modelCount) && availability.modelCount >= 0)) {
          throw new Error(t('opencodeAvailability.failed', 'Could not check project models. Retry the check.'));
        }
        if (!cancelled) setResult({ scope, count: availability.modelCount, error: availability.error });
      } catch (error) {
        if (!cancelled) setResult({ scope, count: null, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { cancelled = true; };
  }, [directory, scope, t]);
  const current = result?.scope === scope ? result : null;
  return <section className="space-y-2 rounded border p-3">
    <h4 className="text-sm font-medium">{t('opencodeAvailability.title', 'Project model availability')}</h4>
    <select aria-label={t('opencodeAvailability.project', 'Check project')} value={directory}
      onChange={(event) => setDirectory(event.target.value)} className="w-full rounded border bg-background p-2 text-sm">
      <option value="">{t('opencodePermissions.home', 'Home directory')}</option>
      {projects.map((project) => <option key={project.name} value={project.fullPath || project.path}>
        {project.displayName || project.name}
      </option>)}
    </select>
    <p role={current?.error ? 'alert' : 'status'} className="text-sm">
      {!current ? t('opencodeAvailability.checking', 'Checking project models…')
        : current.error || (current.count ? t('opencodeAvailability.available', '{{count}} models available', { count: current.count })
          : t('opencodeAvailability.empty', 'No models available in this project.'))}
    </p>
    <p className="text-xs text-muted-foreground">{t('opencodeAvailability.description', 'Uses the project’s native OpenCode configuration, including custom providers and environment credentials. Model availability does not verify a request to the model provider.')}</p>
    <Button variant="outline" size="sm" disabled={!current} onClick={() => setRevision((value) => value + 1)}>
      {t('opencodePermissions.reload', 'Reload')}
    </Button>
  </section>;
}
