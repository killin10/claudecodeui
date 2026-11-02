import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { OpenCodePermissionRule, OpenCodePermissionSettings } from '@/shared/types';

/** Used by OpenCodePermissionsContent to load native sources and save user rules with conflict detection. */
export function useOpenCodePermissions(workspacePath: string) {
  // Server snapshot includes the revision used to detect external config edits.
  const [settings, setSettings] = useState<OpenCodePermissionSettings | null>(null);
  // Unsaved edits must survive validation or server errors.
  const [rules, setRules] = useState<OpenCodePermissionRule[]>([]);
  // Requests disable editing until the authoritative snapshot is available.
  const [status, setStatus] = useState<'loading' | 'saving' | 'ready'>('loading');
  // Errors stay visible until retry or a successful save.
  const [error, setError] = useState<string | null>(null);
  // Explicit reload lets the user recover from a concurrent file change.
  const [reloadVersion, setReloadVersion] = useState(0);

  const reload = useCallback(() => {
    setStatus('loading');
    setError(null);
    setSettings(null);
    setReloadVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void api.providers.opencodeSettingsPermissions(workspacePath || undefined)
      .then((response) => readApiJson<{ data: OpenCodePermissionSettings }>(response))
      .then(({ data }) => {
        if (cancelled) return;
        setSettings(data);
        setRules(data.editable.rules);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => { if (!cancelled) setStatus('ready'); });
    return () => { cancelled = true; };
  }, [workspacePath, reloadVersion]);

  const save = async () => {
    if (!settings || status !== 'ready') return;
    setStatus('saving');
    setError(null);
    try {
      await readApiJson(await api.providers.saveOpenCodeSettingsPermissions({ rules, revision: settings.editable.revision }));
      reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setStatus('ready');
    }
  };
  return { settings, rules, setRules, status, error, reload, save };
}
