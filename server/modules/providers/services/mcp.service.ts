import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  AggregatedMcpServer,
  LLMProvider,
  McpProviderWriteResult,
  McpScope,
  McpServerDefinition,
  ProviderMcpServer,
  SaveMcpServerToProvidersInput,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Servers whose name starts with this are written and removed by a CloudCLI
 * feature toggle (the Browser tab registers `cloudcli-browser`), not by the
 * user, so the settings UI shows them read-only.
 */
const MANAGED_MCP_SERVER_NAME_PREFIX = 'cloudcli-';

const toDefinition = (server: ProviderMcpServer): McpServerDefinition => {
  const { provider: _provider, name: _name, scope: _scope, ...definition } = server;
  return definition;
};

/**
 * Serializes the fields every provider format shares, with object keys sorted,
 * so two copies compare equal regardless of which adapter wrote them. The
 * Codex-only fields are left out: they cannot drift against a provider that
 * never stores them.
 */
const commonFieldsFingerprint = (definition: McpServerDefinition): string => {
  const sortedRecord = (record?: Record<string, string>) => (
    Object.fromEntries(Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right)))
  );
  return JSON.stringify({
    transport: definition.transport,
    command: definition.command ?? null,
    args: definition.args ?? [],
    env: sortedRecord(definition.env),
    url: definition.url ?? null,
    headers: sortedRecord(definition.headers),
  });
};

const aggregateScope = (
  scope: McpScope,
  workspacePath: string | undefined,
  perProvider: Array<{ provider: LLMProvider; servers: ProviderMcpServer[] | null }>,
): AggregatedMcpServer[] => {
  const names = new Set<string>();
  perProvider.forEach(({ servers }) => servers?.forEach((server) => names.add(server.name)));

  return [...names].sort((left, right) => left.localeCompare(right)).map((name) => {
    const copies = perProvider.map(({ provider, servers }) => ({
      provider,
      server: servers?.find((entry) => entry.name === name) ?? null,
      supported: servers !== null,
    }));
    // Registry order decides which copy the row shows; the others are compared against it.
    const reference = copies.find((copy) => copy.server)?.server as ProviderMcpServer;
    const definition = toDefinition(reference);
    const referenceFingerprint = commonFieldsFingerprint(definition);

    const providers = {} as AggregatedMcpServer['providers'];
    let hasDrift = false;
    copies.forEach(({ provider, server, supported }) => {
      const differs = server ? commonFieldsFingerprint(toDefinition(server)) !== referenceFingerprint : false;
      hasDrift ||= differs;
      providers[provider] = {
        presence: server ? 'present' : supported ? 'absent' : 'unsupported',
        differs,
      };
    });

    return {
      name,
      scope,
      workspacePath,
      definition,
      providers,
      hasDrift,
      managed: name.startsWith(MANAGED_MCP_SERVER_NAME_PREFIX),
    };
  });
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : 'Unknown error');

export const providerMcpService = {
  /**
   * Lists MCP servers across every provider, one row per name within a scope.
   *
   * The `user` scope is always included. `project` and `local` need a
   * workspace, so they are empty when `workspacePath` is omitted. A provider
   * whose format lacks a scope shows up as `unsupported` on every row of it.
   */
  async listAggregatedMcpServers(
    options?: { workspacePath?: string },
  ): Promise<Record<McpScope, AggregatedMcpServer[]>> {
    const providers = providerRegistry.listProviders();
    const workspacePath = options?.workspacePath;
    const scopes: McpScope[] = workspacePath ? ['user', 'project', 'local'] : ['user'];
    const grouped: Record<McpScope, AggregatedMcpServer[]> = { user: [], local: [], project: [] };

    for (const scope of scopes) {
      const perProvider = await Promise.all(providers.map(async (provider) => ({
        provider: provider.id,
        servers: provider.mcp.supportsScope(scope)
          ? await provider.mcp.listServersForScope(scope, { workspacePath })
          : null,
      })));
      grouped[scope] = aggregateScope(scope, scope === 'user' ? undefined : workspacePath, perProvider);
    }

    return grouped;
  },

  /**
   * Writes one MCP server to the providers listed in `input.providers` and
   * removes it from the others, then drops the `previousName` copy everywhere
   * after a rename. Each provider is reported separately: an adapter that
   * rejects the definition (an unsupported transport, say) does not stop the rest.
   */
  async saveMcpServerToProviders(input: SaveMcpServerToProvidersInput): Promise<McpProviderWriteResult[]> {
    const { providers: targetProviders, previousName, ...entry } = input;
    const { name, scope, workspacePath, ...definition } = entry;
    const results: McpProviderWriteResult[] = [];

    for (const provider of providerRegistry.listProviders()) {
      const wanted = targetProviders.includes(provider.id);
      try {
        if (wanted) {
          await provider.mcp.upsertServer({ ...definition, name, scope, workspacePath });
          results.push({ provider: provider.id, action: 'saved' });
        } else if (provider.mcp.supportsScope(scope)) {
          const { removed } = await provider.mcp.removeServer({ name, scope, workspacePath });
          results.push({ provider: provider.id, action: removed ? 'removed' : 'unchanged' });
        } else {
          results.push({ provider: provider.id, action: 'unchanged' });
        }
      } catch (error) {
        results.push({ provider: provider.id, action: wanted ? 'saved' : 'removed', error: describeError(error) });
      }
    }

    // The old name goes only once the new one is in place, so a failed write
    // never leaves a provider with neither copy.
    if (previousName && previousName !== name) {
      await providerMcpService.removeMcpServerFromAllProviders({ name: previousName, scope, workspacePath });
    }

    return results;
  },

  /**
   * Lists MCP servers for one provider grouped by supported scopes.
   */
  async listProviderMcpServers(
    providerName: string,
    options?: { workspacePath?: string },
  ): Promise<Record<McpScope, ProviderMcpServer[]>> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.mcp.listServers(options);
  },

  /**
   * Lists MCP servers for one provider scope.
   */
  async listProviderMcpServersForScope(
    providerName: string,
    scope: McpScope,
    options?: { workspacePath?: string },
  ): Promise<ProviderMcpServer[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.mcp.listServersForScope(scope, options);
  },

  /**
   * Adds or updates one provider MCP server.
   */
  async upsertProviderMcpServer(
    providerName: string,
    input: UpsertProviderMcpServerInput,
  ): Promise<ProviderMcpServer> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.mcp.upsertServer(input);
  },

  /**
   * Removes one provider MCP server.
   */
  async removeProviderMcpServer(
    providerName: string,
    input: { name: string; scope?: McpScope; workspacePath?: string },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.mcp.removeServer(input);
  },

  /**
   * Adds one HTTP/stdio MCP server to every provider.
   */
  async addMcpServerToAllProviders(
    input: Omit<UpsertProviderMcpServerInput, 'scope'> & { scope?: Exclude<McpScope, 'local'> },
  ): Promise<Array<{ provider: LLMProvider; created: boolean; error?: string }>> {
    if (input.transport !== 'stdio' && input.transport !== 'http') {
      throw new AppError('Global MCP add supports only "stdio" and "http".', {
        code: 'INVALID_GLOBAL_MCP_TRANSPORT',
        statusCode: 400,
      });
    }

    const scope = input.scope ?? 'project';
    const results: Array<{ provider: LLMProvider; created: boolean; error?: string }> = [];
    const providers = providerRegistry.listProviders();
    for (const provider of providers) {
      try {
        await provider.mcp.upsertServer({ ...input, scope });
        results.push({ provider: provider.id, created: true });
      } catch (error) {
        results.push({
          provider: provider.id,
          created: false,
          error: describeError(error),
        });
      }
    }

    return results;
  },

  /**
   * Removes one MCP server from every provider. Mirrors `addMcpServerToAllProviders`
   * by iterating the live provider registry, so callers stay in sync with which
   * providers exist instead of maintaining their own provider list. A provider
   * whose format lacks the scope is reported as not removed, without an error.
   */
  async removeMcpServerFromAllProviders(
    input: { name: string; scope?: McpScope; workspacePath?: string },
  ): Promise<Array<{ provider: LLMProvider; removed: boolean; error?: string }>> {
    const results: Array<{ provider: LLMProvider; removed: boolean; error?: string }> = [];
    const providers = providerRegistry.listProviders();
    for (const provider of providers) {
      if (!provider.mcp.supportsScope(input.scope ?? 'project')) {
        results.push({ provider: provider.id, removed: false });
        continue;
      }
      try {
        const result = await provider.mcp.removeServer(input);
        results.push({ provider: provider.id, removed: result.removed });
      } catch (error) {
        results.push({
          provider: provider.id,
          removed: false,
          error: describeError(error),
        });
      }
    }

    return results;
  },
};
