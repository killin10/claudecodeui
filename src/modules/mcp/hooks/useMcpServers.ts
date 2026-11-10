import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { MCP_PROVIDER_NAMES } from '@/shared/constants';
import type {
  AggregatedMcpServer,
  McpProject,
  McpProvider,
  McpScope,
  SaveMcpServerPayload,
} from '@/shared/types';
import type { McpCapabilitiesByProvider } from '@/modules/mcp/hooks/useMcpCapabilities';
import { getErrorMessage, getProjectPath, getProviderRejection } from '@/modules/mcp/utils/mcpFormatting';

/** Which half of the MCP page is shown: servers in every provider's user config, or one project's project and local configs. */
export type McpViewScope = 'user' | 'project';

type AggregatedResponse = {
  data: { scopes: Record<McpScope, AggregatedMcpServer[]> };
};

type FanOutResponse = {
  data: { results: Array<{ provider: McpProvider; action: string; error?: string }> };
};

type ProjectOption = {
  path: string;
  label: string;
};

const SCOPE_ORDER: Record<McpScope, number> = { user: 0, project: 1, local: 2 };

const sortServers = (servers: AggregatedMcpServer[]): AggregatedMcpServer[] => (
  [...servers].sort((left, right) => (
    SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope] || left.name.localeCompare(right.name)
  ))
);

/** Stable identity of one row, used for React keys and in-flight chip toggles. */
export const getServerKey = (server: Pick<AggregatedMcpServer, 'scope' | 'workspacePath' | 'name'>): string => (
  `${server.scope}:${server.workspacePath || 'user'}:${server.name}`
);

type UseMcpServersArgs = {
  currentProjects: McpProject[];
  capabilities: McpCapabilitiesByProvider | null;
};

export function useMcpServers({ currentProjects, capabilities }: UseMcpServersArgs) {
  const { t } = useTranslation('settings');
  // User configs are the common case, so the page opens on them; project configs load only when asked for.
  const [viewScope, setViewScope] = useState<McpViewScope>('user');
  // The project the user picked for the project view; empty means "the first project".
  const [pickedProjectPath, setPickedProjectPath] = useState('');
  // The rows of the current view, one per server name, merged across providers by the backend.
  const [servers, setServers] = useState<AggregatedMcpServer[]>([]);
  // True while the list request for the current view is in flight and nothing is shown yet.
  const [isLoading, setIsLoading] = useState(false);
  // The list request's failure; clears on the next successful load.
  const [loadError, setLoadError] = useState<string | null>(null);
  // The last failed chip toggle or delete, shown above the list until the next action.
  const [actionError, setActionError] = useState<string | null>(null);
  // Brief "saved" confirmation after a successful write; auto-clears.
  const [saveStatus, setSaveStatus] = useState<'success' | null>(null);
  // Which row's chips are being written, so the row cannot be toggled twice before the refresh.
  const [pendingServerKey, setPendingServerKey] = useState<string | null>(null);
  // The open form and its edit target: null is closed, `{ editingServer: null }` is "add".
  const [serverForm, setServerForm] = useState<{ editingServer: AggregatedMcpServer | null } | null>(null);
  const activeLoadIdRef = useRef(0);

  const projectOptions = useMemo<ProjectOption[]>(() => {
    const seen = new Set<string>();
    return currentProjects.reduce<ProjectOption[]>((acc, project) => {
      const projectPath = getProjectPath(project);
      if (!projectPath || seen.has(projectPath)) {
        return acc;
      }
      seen.add(projectPath);
      acc.push({ path: projectPath, label: project.displayName || project.projectId });
      return acc;
    }, []);
  }, [currentProjects]);

  // The project view lands on the first project until the user picks another.
  const selectedProjectPath = projectOptions.some((project) => project.path === pickedProjectPath)
    ? pickedProjectPath
    : projectOptions[0]?.path ?? '';
  // The workspace the current view reads from: none for user configs.
  const workspacePath = viewScope === 'project' ? selectedProjectPath : '';

  // Changing what the page looks at closes the form and clears the stale action error with it.
  const changeViewScope = useCallback((nextScope: McpViewScope) => {
    setViewScope(nextScope);
    setServerForm(null);
    setActionError(null);
  }, []);

  const changeSelectedProjectPath = useCallback((nextPath: string) => {
    setPickedProjectPath(nextPath);
    setServerForm(null);
    setActionError(null);
  }, []);

  const refreshServers = useCallback(async () => {
    const loadId = activeLoadIdRef.current + 1;
    activeLoadIdRef.current = loadId;

    if (viewScope === 'project' && !workspacePath) {
      setServers([]);
      setIsLoading(false);
      setLoadError(null);
      return;
    }

    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await api.providers.aggregatedMcpServers(workspacePath ? { workspacePath } : {});
      const body = await readApiJson<AggregatedResponse>(response);
      if (activeLoadIdRef.current !== loadId) {
        return;
      }
      const rows = viewScope === 'user'
        ? body.data.scopes.user
        : [...body.data.scopes.project, ...body.data.scopes.local];
      setServers(sortServers(rows));
    } catch (error) {
      if (activeLoadIdRef.current === loadId) {
        setLoadError(getErrorMessage(error));
      }
    } finally {
      if (activeLoadIdRef.current === loadId) {
        setIsLoading(false);
      }
    }
  }, [viewScope, workspacePath]);

  useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  useEffect(() => {
    if (saveStatus === null) {
      return;
    }
    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  const openForm = useCallback((server?: AggregatedMcpServer) => {
    setServerForm({ editingServer: server ?? null });
  }, []);

  const closeForm = useCallback(() => {
    setServerForm(null);
  }, []);

  const describeFailures = useCallback((failures: Array<{ provider: McpProvider; error?: string }>): string => (
    failures
      .map((failure) => `${MCP_PROVIDER_NAMES[failure.provider]}: ${failure.error || t('mcpServersErrors.unknownError')}`)
      .join('; ')
  ), [t]);

  const submitForm = useCallback(async (payload: SaveMcpServerPayload) => {
    const response = await api.providers.saveMcpServerToProviders(payload.name, payload);
    const body = await readApiJson<FanOutResponse>(response);
    await refreshServers();

    const failures = body.data.results.filter((result) => result.error);
    if (failures.length > 0) {
      throw new Error(t('mcpServersErrors.saveFailedForProviders', { details: describeFailures(failures) }));
    }

    setSaveStatus('success');
    closeForm();
  }, [closeForm, describeFailures, refreshServers, t]);

  const deleteServer = useCallback(async (server: AggregatedMcpServer) => {
    if (!window.confirm(t('mcpServersErrors.deleteConfirm', { name: server.name }))) {
      return;
    }

    setActionError(null);
    setPendingServerKey(getServerKey(server));
    try {
      const response = await api.providers.deleteMcpServerFromAllProviders(server.name, {
        scope: server.scope,
        workspacePath: server.workspacePath,
      });
      await readApiJson<unknown>(response);
      await refreshServers();
      setSaveStatus('success');
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setPendingServerKey(null);
    }
  }, [refreshServers, t]);

  /**
   * Gives one provider its own copy of a row, or takes it away, without touching
   * the other providers' copies. The row's shown definition is what gets written.
   */
  const toggleProvider = useCallback(async (server: AggregatedMcpServer, provider: McpProvider) => {
    const presence = server.providers[provider]?.presence;
    if (!capabilities || presence === 'unsupported' || server.managed) {
      return;
    }

    setActionError(null);
    setPendingServerKey(getServerKey(server));
    try {
      if (presence === 'present') {
        const response = await api.providers.deleteMcpServer(provider, server.name, {
          scope: server.scope,
          workspacePath: server.workspacePath,
        });
        await readApiJson<unknown>(response);
      } else {
        const rejection = getProviderRejection(provider, server.scope, server.definition.transport, capabilities);
        if (rejection) {
          throw new Error(t('mcpForm.providers.rejectedTransport', {
            provider: MCP_PROVIDER_NAMES[provider],
            transport: server.definition.transport,
          }));
        }
        const response = await api.providers.saveMcpServer(provider, {
          ...server.definition,
          name: server.name,
          scope: server.scope,
          workspacePath: server.workspacePath,
        });
        await readApiJson<unknown>(response);
      }
      await refreshServers();
      setSaveStatus('success');
    } catch (error) {
      setActionError(getErrorMessage(error));
    } finally {
      setPendingServerKey(null);
    }
  }, [capabilities, refreshServers, t]);

  return {
    viewScope,
    setViewScope: changeViewScope,
    projectOptions,
    selectedProjectPath,
    setSelectedProjectPath: changeSelectedProjectPath,
    workspacePath,
    servers,
    isLoading,
    loadError,
    actionError,
    saveStatus,
    pendingServerKey,
    serverForm,
    openForm,
    closeForm,
    submitForm,
    deleteServer,
    toggleProvider,
  };
}
