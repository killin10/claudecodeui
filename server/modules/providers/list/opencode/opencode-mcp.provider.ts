import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
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
  } catch {
    return false;
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

const resolveOpenCodeConfigPath = async (scope: McpScope, workspacePath: string): Promise<OpenCodeConfigPath> => {
  const root = scope === 'user'
    ? path.join(os.homedir(), '.config', 'opencode')
    : workspacePath;
  const jsonPath = path.join(root, 'opencode.json');
  const jsoncPath = path.join(root, 'opencode.jsonc');

  if (await fileExists(jsonPath)) {
    return { filePath: jsonPath, exists: true };
  }

  if (await fileExists(jsoncPath)) {
    return { filePath: jsoncPath, exists: true };
  }

  return { filePath: jsonPath, exists: false };
};

/** Used by the OpenCode provider to manage V2 MCP settings in user and project scopes. */
export class OpenCodeMcpProvider extends McpProvider {
  constructor() {
    super('opencode', ['user', 'project'], ['stdio', 'http']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const { filePath } = await resolveOpenCodeConfigPath(scope, workspacePath);
    const config = await readOpenCodeConfig(filePath);
    const mcp = readObjectRecord(config.mcp) ?? {};
    const grouped = 'servers' in mcp || 'timeout' in mcp;
    const servers = grouped ? readObjectRecord(mcp.servers) ?? {} : mcp;
    return Object.fromEntries(Object.entries(servers).map(([name, config]) => [name, normalizeStoredServer(config)]));
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const { filePath } = await resolveOpenCodeConfigPath(scope, workspacePath);
    const config = await readOpenCodeConfig(filePath);
    const mcp = readObjectRecord(config.mcp) ?? {};
    config.mcp = { ...('servers' in mcp || 'timeout' in mcp ? mcp : {}), servers };
    await writeOpenCodeConfig(filePath, config);
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
        name,
        scope,
        transport: 'stdio',
        command,
        args: commandParts.slice(1),
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
