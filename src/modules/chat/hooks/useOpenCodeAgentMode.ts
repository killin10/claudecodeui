import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { api } from '@/shared/api';
import type { LLMProvider, PermissionMode } from '@/shared/types';

/** The provider-state hook uses native agent state without turning passive resume into an agent switch. */
export function useOpenCodeAgentMode(provider: LLMProvider, sessionId: string | undefined,
  setMode: Dispatch<SetStateAction<PermissionMode>>, permissionModes?: readonly PermissionMode[]) {
  const scope = `${provider}:${sessionId ?? 'new'}`;
  // Explicit intent belongs only to the currently open conversation; it is included in queued sends.
  const [intent, setIntent] = useState({ scope, explicit: false });
  if (intent.scope !== scope) setIntent({ scope, explicit: false });
  // A late native-state response must not overwrite a mode the user just selected.
  const selectionRevision = useRef(0);

  useEffect(() => {
    if (provider !== 'opencode' || !sessionId) return;
    if (intent.scope === scope && intent.explicit) return;
    let cancelled = false;
    const revision = selectionRevision.current;
    void api.providers.opencodeSessionAgent(sessionId).then(async (response) => {
      if (!response.ok) throw new Error('Could not read the OpenCode session agent.');
      const body = await response.json();
      const agent = body.data?.agent;
      if (cancelled || revision !== selectionRevision.current || typeof agent !== 'string') return;
      setMode((previous) => agent === 'plan' ? 'plan' : previous === 'plan' ? 'default' : previous);
    }).catch((error) => {
      if (!cancelled) console.error('Unable to synchronize OpenCode agent mode:', error);
    });
    return () => { cancelled = true; };
  }, [provider, sessionId, setMode, permissionModes, intent.explicit, intent.scope, scope]);

  const markExplicit = useCallback(() => {
    selectionRevision.current += 1;
    setIntent({ scope, explicit: true });
  }, [scope]);

  return { permissionModeExplicit: provider === 'opencode' && intent.scope === scope && intent.explicit, markExplicit };
}
