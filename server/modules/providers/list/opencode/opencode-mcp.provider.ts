import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  getOpenCodeConfigDirectory,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  stripJsonComments,
  stripTrailingCommas,
} from '@/shared/utils.js';

type OpenCodeConfigPath = {
  filePath: string;
  exists: boolean;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const readOpenCodeConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(content))) as unknown;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }

    throw error;
  }
};

const writeOpenCodeConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

function normalizeStoredServer(raw: unknown): unknown {
  const server = readObjectRecord(raw);
  if (!server) return raw;
  const { enabled, timeout, ...rest } = server;
  return {
    ...rest,
    ...(typeof enabled === 'boolean' ? { disabled: !enabled } : {}),
    ...(timeout === undefined ? {} : { timeout: typeof timeout === 'number' ? { catalog: timeout } : timeout }),
  };
}

const globalConfigDirectory = getOpenCodeConfigDirectory;

async function configSources(scope: McpScope, workspacePath: string): Promise<string[]> {
  const names = ['opencode.json', 'opencode.jsonc'];
  if (scope === 'user') return names.map((name) => path.join(globalConfigDirectory(), name));
  const ancestors: string[] = [];
  for (let directory = path.resolve(workspacePath); ; directory = path.dirname(directory)) {
    ancestors.unshift(directory);
    if (path.dirname(directory) === directory) break;
  }
  // V2 loads direct ancestor files first, then .opencode directories, each
  // from root to leaf. JSONC outranks JSON within a directory.
  const direct = ancestors.flatMap((directory) => names.map((name) => path.join(directory, name)));
  const supplementary = ancestors.flatMap((directory) => names.map((name) => path.join(directory, '.opencode', name)));
  return [...(process.env.OPENCODE_CONFIG ? [path.resolve(process.env.OPENCODE_CONFIG)] : []), ...direct, ...supplementary]
    .filter((file) => path.dirname(file) !== globalConfigDirectory());
}

function serversIn(config: Record<string, unknown>): Record<string, unknown> {
  const mcp = readObjectRecord(config.mcp) ?? {};
  return 'servers' in mcp || 'timeout' in mcp ? readObjectRecord(mcp.servers) ?? {} : mcp;
}

async function sourceFilesForChange(
  name: string,
  value: unknown,
  sourcePath: string,
  scope: McpScope,
  workspacePath: string,
): Promise<string[]> {
  if (value !== undefined) return [sourcePath];
  // Removing only the winning definition would reveal a lower-priority duplicate.
  const sources = new Set([sourcePath]);
  for (const candidate of await configSources(scope, workspacePath)) {
    if (Object.hasOwn(serversIn(await readOpenCodeConfig(candidate)), name)) sources.add(candidate);
  }
  return [...sources];
}

async function applyServerChanges(filePath: string, entries: Map<string, unknown>): Promise<void> {
  const config = await readOpenCodeConfig(filePath);
  const mcp = readObjectRecord(config.mcp) ?? {};
  const values = serversIn(config);
  for (const [name, value] of entries) {
    if (value === undefined) {
      delete values[name];
      continue;
    }
    const { __cloudcliSource: _source, ...stored } = readObjectRecord(value) ?? {};
    const existing = readObjectRecord(normalizeStoredServer(values[name]));
    // The editor only owns the displayed connection fields. Preserve native
    // options, especially disabled/OAuth, when editing the same transport.
    const preserved = existing?.type === stored.type ? existing : {
      ...(existing?.timeout !== undefined ? { timeout: existing.timeout } : {}),
      ...(existing?.protocol !== undefined ? { protocol: existing.protocol } : {}),
      ...(existing?.codemode !== undefined ? { codemode: existing.codemode } : {}),
    };
    values[name] = {
      ...preserved,
      ...stored,
      disabled: existing?.disabled ?? stored.disabled,
    };
  }
  config.mcp = { ...('servers' in mcp || 'timeout' in mcp ? mcp : {}), servers: values };
  await writeOpenCodeConfig(filePath, config);
}

const resolveOpenCodeConfigPath = async (scope: McpScope, workspacePath: string): Promise<OpenCodeConfigPath> => {
  const root = scope === 'user' ? globalConfigDirectory() : workspacePath;
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const filePath = path.join(root, name);
    if (await fileExists(filePath)) return { filePath, exists: true };
  }
  return { filePath: path.join(root, 'opencode.json'), exists: false };
};

/** Used by the OpenCode provider to manage V2 MCP settings in user and project scopes. */
export class OpenCodeMcpProvider extends McpProvider {
  constructor() {
    super('opencode');
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const servers: Record<string, unknown> = {};
    for (const sourcePath of await configSources(scope, workspacePath)) {
      const config = await readOpenCodeConfig(sourcePath);
      for (const [name, value] of Object.entries(serversIn(config))) {
        servers[name] = { ...readObjectRecord(normalizeStoredServer(value)), __cloudcliSource: sourcePath };
      }
    }
    return servers;
  }

  protected async writeScopedServers(scope: McpScope, workspacePath: string, servers: Record<string, unknown>): Promise<void> {
    const current = await this.readScopedServers(scope, workspacePath);
    const changes = new Map<string, Map<string, unknown>>();
    const defaultPath = (await resolveOpenCodeConfigPath(scope, workspacePath)).filePath;
    for (const name of new Set([...Object.keys(current), ...Object.keys(servers)])) {
      if (JSON.stringify(current[name]) === JSON.stringify(servers[name])) continue;
      const source = readObjectRecord(current[name])?.__cloudcliSource;
      const filePath = typeof source === 'string' ? source : defaultPath;
      for (const sourcePath of await sourceFilesForChange(name, servers[name], filePath, scope, workspacePath)) {
        const entries = changes.get(sourcePath) ?? new Map<string, unknown>();
        entries.set(name, servers[name]);
        changes.set(sourcePath, entries);
      }
    }
    for (const [filePath, entries] of changes) {
      await applyServerChanges(filePath, entries);
    }
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        type: 'local',
        command: [input.command, ...(input.args ?? [])],
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        disabled: false,
        environment: input.env ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      type: 'remote',
      url: input.url,
      disabled: false,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) {
      return null;
    }

    if (config.type === 'local' || config.command !== undefined) {
      const commandParts = typeof config.command === 'string'
        ? [config.command, ...(readStringArray(config.args) ?? [])]
        : readStringArray(config.command);
      const command = commandParts?.[0];
      if (!command) {
        return null;
      }

      return {
        provider: 'opencode',
        sourcePath: readOptionalString(config.__cloudcliSource),
        name,
        scope,
        transport: 'stdio',
        command,
        args: commandParts.slice(1),
        cwd: readOptionalString(config.cwd),
        env: readStringRecord(config.environment) ?? readStringRecord(config.env),
      };
    }

    if (config.type === 'remote' || typeof config.url === 'string') {
      const url = readOptionalString(config.url);
      if (!url) {
        return null;
      }

      return {
        provider: 'opencode',
        sourcePath: readOptionalString(config.__cloudcliSource),
        name,
        scope,
        transport: 'http',
        url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
