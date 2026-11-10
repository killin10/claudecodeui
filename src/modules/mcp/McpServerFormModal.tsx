import { FolderOpen, Globe, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Button, Input, LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { AggregatedMcpServer, McpFormState, McpScope, SaveMcpServerPayload } from '@/shared/types';
import type { McpCapabilitiesByProvider } from '@/modules/mcp/hooks/useMcpCapabilities';
import { useMcpServerForm } from '@/modules/mcp/hooks/useMcpServerForm';

type McpServerFormModalProps = {
  editingServer: AggregatedMcpServer | null;
  scopeOptions: McpScope[];
  workspacePath: string;
  projectLabel?: string;
  capabilities: McpCapabilitiesByProvider;
  onClose: () => void;
  onSubmit: (payload: SaveMcpServerPayload) => Promise<void>;
};

const FIELD_CLASSES = 'w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary';

const CHOICE_CLASSES = (active: boolean) => cn(
  'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
  active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground',
);

/** Rendered by McpServers to add or edit one MCP server across the providers the user ticks. */
export default function McpServerFormModal({
  editingServer,
  scopeOptions,
  workspacePath,
  projectLabel,
  capabilities,
  onClose,
  onSubmit,
}: McpServerFormModalProps) {
  const { t } = useTranslation('settings');
  const {
    formData,
    multilineText,
    availableTransports,
    providerOptions,
    supportedFields,
    describeRejection,
    isEditing,
    isSubmitting,
    submitError,
    jsonValidationError,
    canSubmit,
    updateForm,
    updateScope,
    updateTransport,
    toggleProvider,
    updateJsonInput,
    updateMultilineText,
    handleSubmit,
  } = useMcpServerForm({ editingServer, scopeOptions, workspacePath, capabilities, onSubmit });

  const showScopeChoice = !isEditing && scopeOptions.length > 1;
  const supportsHttpHeaders = formData.transport === 'http' || formData.transport === 'sse';
  const isStdio = formData.transport === 'stdio';

  return createPortal(
    <div data-escape-layer className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-background">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="text-lg font-medium text-foreground">
            {isEditing ? t('mcpForm.title.edit') : t('mcpForm.title.add')}
          </h3>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('mcpForm.actions.cancel')}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-4">
          {/* Where the server is stored: fixed by the view, or project vs Claude-local inside a project. */}
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <label className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.scope.label')}</label>
            {showScopeChoice ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {scopeOptions.map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => updateScope(scope)}
                    className={CHOICE_CLASSES(formData.scope === scope)}
                  >
                    <span className="flex items-center justify-center gap-2">
                      {scope === 'user' ? <Globe className="h-4 w-4" /> : <FolderOpen className="h-4 w-4" />}
                      {t(`mcpForm.scopes.${scope}`)}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm">
                {formData.scope === 'user' ? <Globe className="h-4 w-4" /> : <FolderOpen className="h-4 w-4" />}
                <span>{t(`mcpForm.scopes.${formData.scope}`)}</span>
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">{t(`mcpForm.scopes.${formData.scope}Desc`)}</p>
            {formData.scope !== 'user' && (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {projectLabel ? `${projectLabel} · ` : ''}{formData.workspacePath}
              </p>
            )}
            {isEditing && <p className="mt-2 text-xs text-muted-foreground">{t('mcpForm.scope.cannotChange')}</p>}
          </div>

          {/* Which providers get a copy. A provider that cannot hold this scope or transport is shown but not tickable. */}
          <div>
            <label className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.providers.label')} *</label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {providerOptions.map(({ provider, name, selected, rejection }) => (
                <button
                  key={provider}
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  aria-label={name}
                  disabled={Boolean(rejection)}
                  title={rejection ? describeRejection(rejection) : undefined}
                  onClick={() => toggleProvider(provider)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
                    selected ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:border-primary/50',
                    rejection && 'cursor-not-allowed opacity-40 hover:border-border',
                  )}
                >
                  <LLMProviderLogo provider={provider} className="h-4 w-4" />
                  <span>{name}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {isEditing ? t('mcpForm.providers.editHint') : t('mcpForm.providers.addHint')}
            </p>
          </div>

          {!isEditing && (
            <div className="flex gap-2">
              <button type="button" onClick={() => updateForm('importMode', 'form')} className={CHOICE_CLASSES(formData.importMode === 'form')}>
                {t('mcpForm.importMode.form')}
              </button>
              <button type="button" onClick={() => updateForm('importMode', 'json')} className={CHOICE_CLASSES(formData.importMode === 'json')}>
                {t('mcpForm.importMode.json')}
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className={formData.importMode === 'json' ? 'md:col-span-2' : ''}>
              <label htmlFor="mcp-server-name" className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.fields.serverName')} *</label>
              <Input
                id="mcp-server-name"
                value={formData.name}
                onChange={(event) => updateForm('name', event.target.value)}
                placeholder={t('mcpForm.placeholders.serverName')}
                required
              />
            </div>

            {formData.importMode === 'form' && (
              <div>
                <label htmlFor="mcp-server-transport" className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.fields.transportType')} *</label>
                <select
                  id="mcp-server-transport"
                  value={formData.transport}
                  onChange={(event) => updateTransport(event.target.value as McpFormState['transport'])}
                  className={FIELD_CLASSES}
                >
                  {availableTransports.map((transport) => (
                    <option key={transport} value={transport}>
                      {transport === 'sse' ? 'SSE' : transport.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {formData.importMode === 'json' && (
            <div>
              <label className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.fields.jsonConfig')} *</label>
              <textarea
                value={formData.jsonInput}
                onChange={(event) => updateJsonInput(event.target.value)}
                className={cn(FIELD_CLASSES, 'font-mono', jsonValidationError && 'border-red-500')}
                rows={8}
                placeholder={'{\n  "type": "stdio",\n  "command": "npx",\n  "args": ["@upstash/context7-mcp"]\n}'}
                required
              />
              {jsonValidationError && <p className="mt-1 text-xs text-red-500">{jsonValidationError}</p>}
              <p className="mt-2 text-xs text-muted-foreground">
                {t('mcpForm.validation.jsonHelp')}
                <br />
                - stdio: {'{"type":"stdio","command":"npx","args":["@upstash/context7-mcp"]}'}
                <br />
                - http/sse: {'{"type":"http","url":"https://api.example.com/mcp"}'}
              </p>
            </div>
          )}

          {formData.importMode === 'form' && isStdio && (
            <div className="space-y-4">
              <div>
                <label htmlFor="mcp-server-command" className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.fields.command')} *</label>
                <Input
                  id="mcp-server-command"
                  value={formData.command}
                  onChange={(event) => updateForm('command', event.target.value)}
                  placeholder="npx @my-org/mcp-server"
                  required
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.fields.arguments')}</label>
                <textarea
                  value={multilineText.args}
                  onChange={(event) => updateMultilineText('args', event.target.value)}
                  className={FIELD_CLASSES}
                  rows={3}
                  placeholder="--port&#10;3000"
                />
              </div>

              {supportedFields.has('cwd') && (
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.workingDirectory')}</label>
                  <Input value={formData.cwd} onChange={(event) => updateForm('cwd', event.target.value)} placeholder="." />
                  <p className="mt-1 text-xs text-muted-foreground">{t('mcpForm.providerOnlyField', { providers: 'Codex, Cursor' })}</p>
                </div>
              )}
            </div>
          )}

          {formData.importMode === 'form' && !isStdio && (
            <div>
              <label htmlFor="mcp-server-url" className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.fields.url')} *</label>
              <Input
                id="mcp-server-url"
                value={formData.url}
                onChange={(event) => updateForm('url', event.target.value)}
                placeholder="https://api.example.com/mcp"
                type="url"
                required
              />
            </div>
          )}

          {formData.importMode === 'form' && (
            <div>
              <label className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.fields.envVars')}</label>
              <textarea
                value={multilineText.env}
                onChange={(event) => updateMultilineText('env', event.target.value)}
                className={FIELD_CLASSES}
                rows={3}
                placeholder="API_KEY=your-key&#10;DEBUG=true"
              />
            </div>
          )}

          {formData.importMode === 'form' && supportsHttpHeaders && (
            <div>
              <label className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.fields.headers')}</label>
              <textarea
                value={multilineText.headers}
                onChange={(event) => updateMultilineText('headers', event.target.value)}
                className={FIELD_CLASSES}
                rows={3}
                placeholder="Authorization=Bearer token&#10;X-API-Key=your-key"
              />
            </div>
          )}

          {/* Codex-only fields, shown only while Codex is among the ticked providers. */}
          {formData.importMode === 'form' && isStdio && supportedFields.has('envVars') && (
            <div>
              <label className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.envVarNames')}</label>
              <textarea
                value={multilineText.envVars}
                onChange={(event) => updateMultilineText('envVars', event.target.value)}
                className={FIELD_CLASSES}
                rows={3}
                placeholder="GITHUB_TOKEN&#10;API_KEY"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('mcpForm.providerOnlyField', { providers: 'Codex' })}</p>
            </div>
          )}

          {formData.importMode === 'form' && formData.transport === 'http' && supportedFields.has('bearerTokenEnvVar') && (
            <div>
              <label className="mb-2 block text-sm font-medium text-foreground">{t('mcpForm.bearerTokenEnvVar')}</label>
              <Input
                value={formData.bearerTokenEnvVar}
                onChange={(event) => updateForm('bearerTokenEnvVar', event.target.value)}
                placeholder="MCP_TOKEN"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('mcpForm.providerOnlyField', { providers: 'Codex' })}</p>
            </div>
          )}

          {submitError && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
              {submitError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('mcpForm.actions.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || !canSubmit}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {isSubmitting
                ? t('mcpForm.actions.saving')
                : isEditing
                  ? t('mcpForm.actions.updateServer')
                  : t('mcpForm.actions.addServer')}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
