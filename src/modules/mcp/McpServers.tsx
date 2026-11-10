import { AlertTriangle, Edit3, ExternalLink, FolderOpen, Globe, Lock, Plus, Server, Terminal, Trash2, Users, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AggregatedMcpServer, McpProject, McpProvider, McpScope, McpTransport } from '@/shared/types';
import { cn, IS_PLATFORM } from '@/shared/utils';
import { Badge, Button, LLMProviderLogo, Pill, PillBar } from '@/shared/ui';
import { MCP_PROVIDER_NAMES, MCP_PROVIDERS } from '@/shared/constants';
import { useMcpCapabilities } from '@/modules/mcp/hooks/useMcpCapabilities';
import { getServerKey, useMcpServers } from '@/modules/mcp/hooks/useMcpServers';
import { getProviderRejection, maskSecret } from '@/modules/mcp/utils/mcpFormatting';
import McpServerFormModal from '@/modules/mcp/McpServerFormModal';

type McpServersProps = {
  currentProjects: McpProject[];
};

const PROJECT_SCOPES: McpScope[] = ['project', 'local'];

const getTransportIcon = (transport: McpTransport) => {
  if (transport === 'stdio') {
    return <Terminal className="h-4 w-4" />;
  }
  if (transport === 'sse') {
    return <Zap className="h-4 w-4" />;
  }
  return <Globe className="h-4 w-4" />;
};

function ConfigLine({ label, children }: { label: string; children: string }) {
  if (!children) {
    return null;
  }

  return (
    <div>
      {label}:{' '}
      <code className="rounded bg-muted px-1 text-xs">{children}</code>
    </div>
  );
}

function TeamMcpFeatureCard() {
  const { t } = useTranslation('settings');
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
          <Users className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium text-foreground">{t('mcpTeamCard.title')}</h4>
            <Lock className="h-3 w-3 text-muted-foreground/60" />
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('mcpTeamCard.description')}
          </p>
          <a
            href="https://cloudcli.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:underline"
          >
            {t('mcpTeamCard.proLink')}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

type ProviderChipProps = {
  provider: McpProvider;
  server: AggregatedMcpServer;
  disabledReason: string | null;
  pending: boolean;
  onToggle: () => void;
};

// One provider's copy of a row: solid when present, dashed when absent, muted
// when the provider cannot hold it. Clicking writes or removes that copy only.
function ProviderChip({ provider, server, disabledReason, pending, onToggle }: ProviderChipProps) {
  const { t } = useTranslation('settings');
  const { presence, differs } = server.providers[provider] ?? { presence: 'absent', differs: false };
  const present = presence === 'present';
  const blocked = Boolean(disabledReason) || server.managed;
  const title = disabledReason
    ?? (differs
      ? t('mcpServers.providerChip.differs', { provider: MCP_PROVIDER_NAMES[provider] })
      : t(present ? 'mcpServers.providerChip.remove' : 'mcpServers.providerChip.add', { provider: MCP_PROVIDER_NAMES[provider] }));

  return (
    <button
      type="button"
      role="switch"
      aria-checked={present}
      aria-label={MCP_PROVIDER_NAMES[provider]}
      disabled={blocked || pending}
      title={title}
      onClick={onToggle}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
        present
          ? 'border-primary/60 bg-primary/10 text-foreground'
          : 'border-dashed border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
        differs && 'border-amber-500/70 bg-amber-500/10',
        presence === 'unsupported' && 'opacity-40',
        (blocked || pending) && 'cursor-not-allowed hover:border-border hover:text-muted-foreground',
      )}
    >
      <LLMProviderLogo provider={provider} className="h-3.5 w-3.5" />
      {MCP_PROVIDER_NAMES[provider]}
      {differs && <AlertTriangle className="h-3 w-3 text-amber-600" />}
    </button>
  );
}

/** Rendered by the settings module's MCP tab to list and manage MCP servers across every provider. */
export default function McpServers({ currentProjects }: McpServersProps) {
  const { t } = useTranslation('settings');
  const { capabilities, error: capabilitiesError } = useMcpCapabilities();
  const {
    viewScope,
    setViewScope,
    projectOptions,
    selectedProjectPath,
    setSelectedProjectPath,
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
  } = useMcpServers({ currentProjects, capabilities });

  const selectedProject = projectOptions.find((project) => project.path === selectedProjectPath);
  const canAdd = Boolean(capabilities) && (viewScope === 'user' || Boolean(workspacePath));
  const errorMessage = capabilitiesError || actionError || loadError;

  const chipDisabledReason = (server: AggregatedMcpServer, provider: McpProvider): string | null => {
    const { presence } = server.providers[provider] ?? { presence: 'absent' };
    if (presence === 'unsupported') {
      return t('mcpForm.providers.rejectedScope', { provider: MCP_PROVIDER_NAMES[provider], scope: server.scope });
    }
    if (presence === 'absent' && capabilities) {
      const rejection = getProviderRejection(provider, server.scope, server.definition.transport, capabilities);
      if (rejection) {
        return t('mcpForm.providers.rejectedTransport', { provider: MCP_PROVIDER_NAMES[provider], transport: server.definition.transport });
      }
    }
    // The last copy goes through Delete, which asks first, rather than a chip click.
    const presentCount = MCP_PROVIDERS.filter((entry) => server.providers[entry]?.presence === 'present').length;
    if (presence === 'present' && presentCount === 1) {
      return t('mcpServers.providerChip.lastCopy');
    }
    return null;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Server className="mt-0.5 h-5 w-5 flex-shrink-0 text-purple-500" />
          <div className="min-w-0 space-y-1">
            <h3 className="text-lg font-medium text-foreground">{t('mcpServers.title')}</h3>
            <p className="text-sm text-muted-foreground">{t('mcpServers.crossProviderDescription')}</p>
          </div>
        </div>
        <Button
          onClick={() => openForm()}
          disabled={!canAdd}
          className="w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
        >
          <Plus className="mr-2 h-4 w-4" />
          {t('mcpServers.addButton')}
        </Button>
      </div>

      {/* User configs vs one project's configs; the project view also needs a project picked. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <PillBar>
          <Pill isActive={viewScope === 'user'} onClick={() => setViewScope('user')}>
            <Globe className="h-3.5 w-3.5" />
            {t('mcpServers.view.user')}
          </Pill>
          <Pill isActive={viewScope === 'project'} onClick={() => setViewScope('project')}>
            <FolderOpen className="h-3.5 w-3.5" />
            {t('mcpServers.view.project')}
          </Pill>
        </PillBar>
        {viewScope === 'project' && (
          <select
            aria-label={t('mcpServers.view.selectProject')}
            value={selectedProjectPath}
            onChange={(event) => setSelectedProjectPath(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            {projectOptions.length === 0 && <option value="">{t('mcpServers.view.noProjects')}</option>}
            {projectOptions.map((project) => (
              <option key={project.path} value={project.path}>{project.label}</option>
            ))}
          </select>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {viewScope === 'user' ? t('mcpServers.view.userHint') : t('mcpServers.view.projectHint')}
      </p>

      <div className="min-h-4">
        {saveStatus === 'success' && (
          <span className="animate-in fade-in text-xs text-muted-foreground">{t('saveStatus.success')}</span>
        )}
      </div>

      {errorMessage && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
          {errorMessage}
        </div>
      )}

      <div className="space-y-2">
        {isLoading && servers.length === 0 && (
          <div className="py-8 text-center text-muted-foreground">{t('mcpServers.loading')}</div>
        )}

        {servers.map((server) => {
          const key = getServerKey(server);
          const pending = pendingServerKey === key;
          const { definition } = server;

          return (
            <div key={key} className="rounded-lg border border-border bg-card/50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    {!server.managed && getTransportIcon(definition.transport)}
                    <span className="font-medium text-foreground">{server.name}</span>
                    {!server.managed && (
                      <>
                        <Badge variant="outline" className="text-xs">{definition.transport}</Badge>
                        {server.scope === 'local' && (
                          <Badge variant="outline" className="text-xs">{t('mcpForm.scopes.local')}</Badge>
                        )}
                        {server.hasDrift && (
                          <Badge variant="outline" className="gap-1 border-amber-500/60 text-xs text-amber-700 dark:text-amber-400">
                            <AlertTriangle className="h-3 w-3" />
                            {t('mcpServers.drift.badge')}
                          </Badge>
                        )}
                      </>
                    )}
                    {server.managed && (
                      <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
                        <Lock className="h-3 w-3" />
                        {t('mcpServers.managed.badge')}
                      </Badge>
                    )}
                  </div>

                  <div className="space-y-1 text-sm text-muted-foreground">
                    {!server.managed && (
                      <>
                        <ConfigLine label={t('mcpServers.config.command')}>{definition.command || ''}</ConfigLine>
                        <ConfigLine label={t('mcpServers.config.url')}>{definition.url || ''}</ConfigLine>
                        <ConfigLine label={t('mcpServers.config.args')}>{(definition.args || []).join(' ')}</ConfigLine>
                        <ConfigLine label={t('mcpServers.config.cwd')}>{definition.cwd || ''}</ConfigLine>
                        {definition.env && Object.keys(definition.env).length > 0 && (
                          <ConfigLine label={t('mcpServers.config.environment')}>
                            {Object.entries(definition.env).map(([envKey, value]) => `${envKey}=${maskSecret(value)}`).join(', ')}
                          </ConfigLine>
                        )}
                        {definition.envVars && definition.envVars.length > 0 && (
                          <ConfigLine label={t('mcpServers.config.envVars')}>{definition.envVars.join(', ')}</ConfigLine>
                        )}
                      </>
                    )}
                    {server.managed && <div className="text-xs">{t('mcpServers.managed.hint')}</div>}
                    {server.hasDrift && <div className="text-xs text-amber-700 dark:text-amber-400">{t('mcpServers.drift.hint')}</div>}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {MCP_PROVIDERS.map((provider) => (
                      <ProviderChip
                        key={provider}
                        provider={provider}
                        server={server}
                        disabledReason={chipDisabledReason(server, provider)}
                        pending={pending}
                        onToggle={() => void toggleProvider(server, provider)}
                      />
                    ))}
                  </div>
                </div>

                {!server.managed && (
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={() => openForm(server)}
                      variant="ghost"
                      size="sm"
                      disabled={!capabilities || pending}
                      className="text-muted-foreground hover:text-foreground"
                      title={t('mcpServers.actions.edit')}
                      aria-label={t('mcpServers.actions.edit')}
                    >
                      <Edit3 className="h-4 w-4" />
                    </Button>
                    <Button
                      onClick={() => void deleteServer(server)}
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      className="text-red-600 hover:text-red-700"
                      title={t('mcpServers.actions.delete')}
                      aria-label={t('mcpServers.actions.delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {!isLoading && !loadError && servers.length === 0 && (
          <div className="py-8 text-center text-muted-foreground">
            {viewScope === 'project' && !workspacePath ? t('mcpServers.view.noProjects') : t('mcpServers.empty')}
          </div>
        )}
      </div>

      {!IS_PLATFORM && <TeamMcpFeatureCard />}

      {/* Mounted only while open: each instance runs a full useMcpServerForm. */}
      {serverForm && capabilities && (
        <McpServerFormModal
          editingServer={serverForm.editingServer}
          scopeOptions={viewScope === 'user' ? ['user'] : PROJECT_SCOPES}
          workspacePath={workspacePath}
          projectLabel={selectedProject?.label}
          capabilities={capabilities}
          onClose={closeForm}
          onSubmit={submitForm}
        />
      )}
    </div>
  );
}
