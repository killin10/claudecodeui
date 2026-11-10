import { type FormEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MCP_PROVIDER_NAMES, MCP_PROVIDERS } from '@/shared/constants';
import type {
  AggregatedMcpServer,
  McpFormState,
  McpProvider,
  McpScope,
  McpTransport,
  SaveMcpServerPayload,
} from '@/shared/types';
import type { McpCapabilitiesByProvider } from '@/modules/mcp/hooks/useMcpCapabilities';
import {
  createMcpPayloadFromForm,
  formatKeyValueLines,
  getErrorMessage,
  getProviderRejection,
  getSupportedFields,
  isMcpTransport,
  parseKeyValueLines,
  parseListLines,
  type McpProviderRejection,
} from '@/modules/mcp/utils/mcpFormatting';

type UseMcpServerFormArgs = {
  editingServer: AggregatedMcpServer | null;
  /** Scopes this form may write to: `['user']` from the user view, `['project', 'local']` from a project. */
  scopeOptions: McpScope[];
  /** The project the form writes into when the scope is not `user`; empty in the user view. */
  workspacePath: string;
  capabilities: McpCapabilitiesByProvider;
  onSubmit: (payload: SaveMcpServerPayload) => Promise<void>;
};

type MultilineFieldText = {
  args: string;
  env: string;
  headers: string;
  envVars: string;
  envHttpHeaders: string;
};

const DEFAULT_MCP_FORM: McpFormState = {
  name: '',
  scope: 'user',
  workspacePath: '',
  providers: [],
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: '',
  headers: {},
  envVars: [],
  bearerTokenEnvVar: '',
  envHttpHeaders: {},
  importMode: 'form',
  jsonInput: '',
};

const providersAccepting = (
  scope: McpScope,
  transport: McpTransport,
  capabilities: McpCapabilitiesByProvider,
): McpProvider[] => (
  MCP_PROVIDERS.filter((provider) => getProviderRejection(provider, scope, transport, capabilities) === null)
);

const createBlankForm = (
  scope: McpScope,
  workspacePath: string,
  capabilities: McpCapabilitiesByProvider,
): McpFormState => ({
  ...DEFAULT_MCP_FORM,
  scope,
  workspacePath: scope === 'user' ? '' : workspacePath,
  // A new server goes to every provider that can take it; the user unticks the rest.
  providers: providersAccepting(scope, DEFAULT_MCP_FORM.transport, capabilities),
  args: [],
  env: {},
  headers: {},
  envVars: [],
  envHttpHeaders: {},
});

const createFormStateFromServer = (server: AggregatedMcpServer): McpFormState => ({
  ...DEFAULT_MCP_FORM,
  name: server.name,
  scope: server.scope,
  workspacePath: server.workspacePath || '',
  providers: MCP_PROVIDERS.filter((provider) => server.providers[provider]?.presence === 'present'),
  transport: server.definition.transport,
  command: server.definition.command || '',
  args: server.definition.args || [],
  env: server.definition.env || {},
  cwd: server.definition.cwd || '',
  url: server.definition.url || '',
  headers: server.definition.headers || {},
  envVars: server.definition.envVars || [],
  bearerTokenEnvVar: server.definition.bearerTokenEnvVar || '',
  envHttpHeaders: server.definition.envHttpHeaders || {},
});

const createMultilineTextFromForm = (formData: McpFormState): MultilineFieldText => ({
  args: formData.args.join('\n'),
  env: formatKeyValueLines(formData.env),
  headers: formatKeyValueLines(formData.headers),
  envVars: formData.envVars.join('\n'),
  envHttpHeaders: formatKeyValueLines(formData.envHttpHeaders),
});

export function useMcpServerForm({
  editingServer,
  scopeOptions,
  workspacePath,
  capabilities,
  onSubmit,
}: UseMcpServerFormArgs) {
  const { t } = useTranslation('settings');
  const initialForm = () => (
    editingServer
      ? createFormStateFromServer(editingServer)
      : createBlankForm(scopeOptions[0] ?? 'user', workspacePath, capabilities)
  );
  // The structured form values; textareas keep their own raw text below until submit.
  const [formData, setFormData] = useState<McpFormState>(initialForm);
  // Raw textarea text, so blank lines and half-typed KEY=value entries survive while editing.
  const [multilineText, setMultilineText] = useState<MultilineFieldText>(() => createMultilineTextFromForm(initialForm()));
  // Live validation message for the pasted JSON, cleared as soon as the JSON parses.
  const [jsonValidationError, setJsonValidationError] = useState('');
  // Disables the submit button while the save request is in flight.
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The save request's error, shown inside the modal so the user can fix the form and retry.
  const [submitError, setSubmitError] = useState<string | null>(null);

  // The modal is mounted only while open and remounted per edit target, so the
  // initializers above are the only place the form is seeded.
  const isEditing = Boolean(editingServer);

  // Every transport some provider can speak within this scope; picking one a
  // provider lacks unticks that provider rather than hiding the transport.
  const availableTransports = useMemo<McpTransport[]>(() => {
    const transports = new Set<McpTransport>();
    MCP_PROVIDERS.forEach((provider) => {
      const providerCapabilities = capabilities[provider];
      if (providerCapabilities?.scopes.includes(formData.scope)) {
        providerCapabilities.transports.forEach((transport) => transports.add(transport));
      }
    });
    return (['stdio', 'http', 'sse'] as McpTransport[]).filter((transport) => transports.has(transport));
  }, [capabilities, formData.scope]);

  const providerOptions = useMemo(() => (
    MCP_PROVIDERS.map((provider) => ({
      provider,
      name: MCP_PROVIDER_NAMES[provider],
      selected: formData.providers.includes(provider),
      rejection: getProviderRejection(provider, formData.scope, formData.transport, capabilities),
    }))
  ), [capabilities, formData.providers, formData.scope, formData.transport]);

  const supportedFields = useMemo(
    () => getSupportedFields(formData.providers, capabilities),
    [capabilities, formData.providers],
  );

  const describeRejection = (rejection: McpProviderRejection): string => {
    const provider = MCP_PROVIDER_NAMES[rejection.provider];
    if (rejection.reason === 'scope') {
      return t('mcpForm.providers.rejectedScope', { provider, scope: formData.scope });
    }
    if (rejection.reason === 'transport') {
      return t('mcpForm.providers.rejectedTransport', { provider, transport: formData.transport });
    }
    return t('mcpForm.providers.rejectedUnknown', { provider });
  };

  const updateForm = <K extends keyof McpFormState>(key: K, value: McpFormState[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const updateScope = (scope: McpScope) => {
    if (!scopeOptions.includes(scope)) {
      return;
    }
    setFormData((prev) => ({
      ...prev,
      scope,
      workspacePath: scope === 'user' ? '' : workspacePath,
      providers: prev.providers.filter((provider) => getProviderRejection(provider, scope, prev.transport, capabilities) === null),
    }));
  };

  const updateTransport = (transport: McpTransport) => {
    if (!availableTransports.includes(transport)) {
      return;
    }
    setFormData((prev) => ({
      ...prev,
      transport,
      providers: prev.providers.filter((provider) => getProviderRejection(provider, prev.scope, transport, capabilities) === null),
    }));
  };

  const toggleProvider = (provider: McpProvider) => {
    setFormData((prev) => {
      if (prev.providers.includes(provider)) {
        return { ...prev, providers: prev.providers.filter((entry) => entry !== provider) };
      }
      if (getProviderRejection(provider, prev.scope, prev.transport, capabilities)) {
        return prev;
      }
      return { ...prev, providers: MCP_PROVIDERS.filter((entry) => entry === provider || prev.providers.includes(entry)) };
    });
  };

  const validateJsonInput = (value: string) => {
    if (!value.trim()) {
      setJsonValidationError('');
      return;
    }

    try {
      const parsed = JSON.parse(value) as { type?: unknown; transport?: unknown; command?: unknown; url?: unknown };
      const transportInput = parsed.transport || parsed.type;
      if (!isMcpTransport(transportInput)) {
        setJsonValidationError(t('mcpForm.validation.missingType'));
      } else if (!availableTransports.includes(transportInput)) {
        setJsonValidationError(t('mcpForm.validation.unsupportedTransport', { transport: transportInput }));
      } else if (transportInput === 'stdio' && !parsed.command) {
        setJsonValidationError(t('mcpForm.validation.stdioRequiresCommand'));
      } else if ((transportInput === 'http' || transportInput === 'sse') && !parsed.url) {
        setJsonValidationError(t('mcpForm.validation.httpRequiresUrl', { type: transportInput }));
      } else {
        setJsonValidationError('');
      }
    } catch {
      setJsonValidationError(t('mcpForm.validation.invalidJson'));
    }
  };

  const updateJsonInput = (value: string) => {
    setFormData((prev) => ({ ...prev, jsonInput: value }));
    validateJsonInput(value);
  };

  const updateMultilineText = <K extends keyof MultilineFieldText>(key: K, value: MultilineFieldText[K]) => {
    setMultilineText((prev) => ({ ...prev, [key]: value }));
  };

  const createSubmitFormData = (): McpFormState => ({
    ...formData,
    args: parseListLines(multilineText.args),
    env: parseKeyValueLines(multilineText.env),
    headers: parseKeyValueLines(multilineText.headers),
    envVars: parseListLines(multilineText.envVars),
    envHttpHeaders: parseKeyValueLines(multilineText.envHttpHeaders),
  });

  const canSubmit = useMemo(() => {
    if (!formData.name.trim() || formData.providers.length === 0) {
      return false;
    }

    if (formData.scope !== 'user' && !formData.workspacePath.trim()) {
      return false;
    }

    if (formData.importMode === 'json') {
      return Boolean(formData.jsonInput.trim()) && !jsonValidationError;
    }

    if (formData.transport === 'stdio') {
      return Boolean(formData.command.trim());
    }

    return Boolean(formData.url.trim());
  }, [formData, jsonValidationError]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const payload = createMcpPayloadFromForm(createSubmitFormData(), capabilities, {
        rejectionMessage: describeRejection,
      });
      await onSubmit({
        ...payload,
        previousName: editingServer && editingServer.name !== payload.name ? editingServer.name : undefined,
      });
    } catch (error) {
      setSubmitError(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
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
  };
}
