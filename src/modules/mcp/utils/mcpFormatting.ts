import type { McpCapabilitiesByProvider } from '@/modules/mcp/hooks/useMcpCapabilities';
import type {
  KeyValueMap,
  McpFormState,
  McpProvider,
  McpProviderField,
  McpScope,
  McpTransport,
  SaveMcpServerPayload,
} from '@/shared/types';

/** Why a provider cannot take part in a save, for the form's error message and the disabled checkbox hint. */
export type McpProviderRejection = { provider: McpProvider; reason: 'scope' | 'transport' | 'unknown' };

type CreateMcpPayloadOptions = {
  rejectionMessage?: (rejection: McpProviderRejection) => string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const readString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const readStringArray = (value: unknown): string[] | undefined => (
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined
);

const readStringRecord = (value: unknown): KeyValueMap | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized: KeyValueMap = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (typeof entry === 'string') {
      normalized[key] = entry;
    }
  });

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

export const formatKeyValueLines = (value: KeyValueMap): string => (
  Object.entries(value).map(([key, entry]) => `${key}=${entry}`).join('\n')
);

export const parseKeyValueLines = (value: string): KeyValueMap => {
  const normalized: KeyValueMap = {};
  value.split('\n').forEach((line) => {
    const [key, ...valueParts] = line.split('=');
    if (key?.trim()) {
      normalized[key.trim()] = valueParts.join('=').trim();
    }
  });
  return normalized;
};

export const parseListLines = (value: string): string[] => (
  value.split('\n').map((entry) => entry.trim()).filter(Boolean)
);

export const maskSecret = (value: unknown): string => {
  const normalizedValue = String(value ?? '');
  if (normalizedValue.length <= 4) {
    return '****';
  }

  return `${normalizedValue.slice(0, 2)}****${normalizedValue.slice(-2)}`;
};

export const isMcpTransport = (value: unknown): value is McpTransport => (
  value === 'stdio' || value === 'http' || value === 'sse'
);

export const getProjectPath = (project: { fullPath?: string; path?: string }): string => (
  project.fullPath || project.path || ''
);

export const getErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : 'Unknown error'
);

/**
 * Why `provider` cannot hold a server with this scope and transport, or null
 * when it can. Unknown capabilities (not loaded, or a provider the backend no
 * longer reports) count as a rejection so nothing is written blind.
 */
export const getProviderRejection = (
  provider: McpProvider,
  scope: McpScope,
  transport: McpTransport,
  capabilities: McpCapabilitiesByProvider,
): McpProviderRejection | null => {
  const providerCapabilities = capabilities[provider];
  if (!providerCapabilities) {
    return { provider, reason: 'unknown' };
  }
  if (!providerCapabilities.scopes.includes(scope)) {
    return { provider, reason: 'scope' };
  }
  if (!providerCapabilities.transports.includes(transport)) {
    return { provider, reason: 'transport' };
  }
  return null;
};

/** The provider-native fields at least one of the given providers can persist; the form shows only these. */
export const getSupportedFields = (
  providers: McpProvider[],
  capabilities: McpCapabilitiesByProvider,
): Set<McpProviderField> => (
  new Set(providers.flatMap((provider) => capabilities[provider]?.fields ?? []))
);

const assertProvidersAccept = (
  formData: Pick<McpFormState, 'providers' | 'scope'>,
  transport: McpTransport,
  capabilities: McpCapabilitiesByProvider,
  options?: CreateMcpPayloadOptions,
) => {
  if (formData.providers.length === 0) {
    throw new Error('Select at least one provider');
  }
  for (const provider of formData.providers) {
    const rejection = getProviderRejection(provider, formData.scope, transport, capabilities);
    if (rejection) {
      throw new Error(
        options?.rejectionMessage?.(rejection) ?? `${provider} does not support ${rejection.reason === 'scope' ? formData.scope : transport} MCP servers`,
      );
    }
  }
};

// Codex-only fields ride along only when a selected provider can store them, so
// a Claude-only save never carries fields Claude would silently drop.
const pickProviderFields = (
  fields: Set<McpProviderField>,
  values: { cwd?: string; envVars?: string[]; bearerTokenEnvVar?: string; envHttpHeaders?: KeyValueMap },
) => ({
  cwd: fields.has('cwd') ? values.cwd : undefined,
  envVars: fields.has('envVars') ? values.envVars : undefined,
  bearerTokenEnvVar: fields.has('bearerTokenEnvVar') ? values.bearerTokenEnvVar : undefined,
  envHttpHeaders: fields.has('envHttpHeaders') ? values.envHttpHeaders : undefined,
});

export const parseJsonMcpPayload = (
  formData: McpFormState,
  capabilities: McpCapabilitiesByProvider,
  options?: CreateMcpPayloadOptions,
): SaveMcpServerPayload => {
  const parsed = JSON.parse(formData.jsonInput) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('JSON configuration must be an object');
  }

  const transportInput = readString(parsed.transport) ?? readString(parsed.type);
  const transport = isMcpTransport(transportInput) ? transportInput : undefined;
  if (!transport) {
    throw new Error('Missing required field: type');
  }

  assertProvidersAccept(formData, transport, capabilities, options);

  if (transport === 'stdio' && !readString(parsed.command)) {
    throw new Error('stdio type requires a command field');
  }

  if ((transport === 'http' || transport === 'sse') && !readString(parsed.url)) {
    throw new Error(`${transport} type requires a url field`);
  }

  const fields = getSupportedFields(formData.providers, capabilities);
  return {
    name: formData.name.trim(),
    scope: formData.scope,
    workspacePath: formData.scope === 'user' ? undefined : formData.workspacePath,
    providers: formData.providers,
    transport,
    command: readString(parsed.command),
    args: readStringArray(parsed.args) ?? [],
    env: readStringRecord(parsed.env) ?? {},
    url: readString(parsed.url),
    headers: readStringRecord(parsed.headers ?? parsed.http_headers) ?? {},
    ...pickProviderFields(fields, {
      cwd: readString(parsed.cwd),
      envVars: readStringArray(parsed.envVars ?? parsed.env_vars) ?? [],
      bearerTokenEnvVar: readString(parsed.bearerTokenEnvVar ?? parsed.bearer_token_env_var),
      envHttpHeaders: readStringRecord(parsed.envHttpHeaders ?? parsed.env_http_headers) ?? {},
    }),
  };
};

/**
 * Turns the form into the fan-out save body, keeping only the connection
 * fields that fit the transport and the extra fields some selected provider
 * can persist. Throws when a selected provider cannot hold the server.
 */
export const createMcpPayloadFromForm = (
  formData: McpFormState,
  capabilities: McpCapabilitiesByProvider,
  options?: CreateMcpPayloadOptions,
): SaveMcpServerPayload => {
  if (formData.importMode === 'json') {
    return parseJsonMcpPayload(formData, capabilities, options);
  }

  assertProvidersAccept(formData, formData.transport, capabilities, options);
  const fields = getSupportedFields(formData.providers, capabilities);
  const isStdio = formData.transport === 'stdio';

  return {
    name: formData.name.trim(),
    scope: formData.scope,
    workspacePath: formData.scope === 'user' ? undefined : formData.workspacePath,
    providers: formData.providers,
    transport: formData.transport,
    command: isStdio ? formData.command.trim() : undefined,
    args: isStdio ? formData.args : undefined,
    env: formData.env,
    url: isStdio ? undefined : formData.url.trim(),
    headers: isStdio ? undefined : formData.headers,
    ...pickProviderFields(fields, {
      cwd: formData.cwd.trim() || undefined,
      envVars: formData.envVars,
      bearerTokenEnvVar: formData.bearerTokenEnvVar.trim() || undefined,
      envHttpHeaders: formData.envHttpHeaders,
    }),
  };
};
