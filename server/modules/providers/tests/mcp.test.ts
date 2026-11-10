import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import TOML from '@iarna/toml';

import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { AppError } from '@/shared/utils.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const readJson = async (filePath: string): Promise<Record<string, unknown>> => {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
};

test('editing OpenCode MCP preserves native options and keeps disabled servers disabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-mcp-preserve-'));
  const filename = path.join(root, 'opencode.json');
  const remote = { type: 'remote', url: 'https://example.test/mcp', disabled: true,
    oauth: false, timeout: { execution: 90000 }, protocol: 'legacy', codemode: false };
  await fs.writeFile(filename, JSON.stringify({ mcp: { servers: { remote } } }));
  try {
    await providerMcpService.upsertProviderMcpServer('opencode', {
      scope: 'project', workspacePath: root, name: 'remote', transport: 'http',
      url: remote.url, headers: { 'x-test': 'new' },
    });
    const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
    assert.deepEqual(saved.mcp.servers.remote, { ...remote, headers: { 'x-test': 'new' } });
    await providerMcpService.upsertProviderMcpServer('opencode', {
      scope: 'project', workspacePath: root, name: 'remote', transport: 'stdio',
      command: 'node', args: ['mcp.js'], cwd: root,
    });
    const changed = JSON.parse(await fs.readFile(filename, 'utf8')).mcp.servers.remote;
    assert.equal(changed.disabled, true);
    assert.equal(changed.oauth, undefined);
    assert.equal(changed.url, undefined);
    assert.equal(changed.cwd, root);
    assert.deepEqual(changed.timeout, remote.timeout);
    const listed = await providerMcpService.listProviderMcpServers('opencode', { workspacePath: root });
    assert.equal(listed.project.find((server) => server.name === 'remote')?.cwd, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * This test covers Claude MCP support for all scopes (user/local/project) and all transports (stdio/http/sse),
 * including add, update/list, and remove operations.
 */
test('providerMcpService handles claude MCP scopes/transports with file-backed persistence', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-claude-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'my-server'],
      env: { API_KEY: 'secret' },
    });

    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-local-http',
      scope: 'local',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      workspacePath,
    });

    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-project-sse',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.com/sse',
      headers: { 'X-API-Key': 'abc' },
      workspacePath,
    });

    const grouped = await providerMcpService.listProviderMcpServers('claude', { workspacePath });
    assert.ok(grouped.user.some((server) => server.name === 'claude-user-stdio' && server.transport === 'stdio'));
    assert.ok(grouped.local.some((server) => server.name === 'claude-local-http' && server.transport === 'http'));
    assert.ok(grouped.project.some((server) => server.name === 'claude-project-sse' && server.transport === 'sse'));

    // update behavior is the same upsert route with same name
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-project-sse',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.com/sse-updated',
      headers: { 'X-API-Key': 'updated' },
      workspacePath,
    });

    const projectConfig = await readJson(path.join(workspacePath, '.mcp.json'));
    const projectServers = projectConfig.mcpServers as Record<string, unknown>;
    const projectServer = projectServers['claude-project-sse'] as Record<string, unknown>;
    assert.equal(projectServer.url, 'https://example.com/sse-updated');

    const removeResult = await providerMcpService.removeProviderMcpServer('claude', {
      name: 'claude-local-http',
      scope: 'local',
      workspacePath,
    });
    assert.equal(removeResult.removed, true);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers Codex MCP support for user/project scopes, stdio/http formats,
 * and validation for unsupported scope/transport combinations.
 */
test('providerMcpService handles codex MCP TOML config and capability validation', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-codex-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('codex', {
      name: 'codex-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'python',
      args: ['server.py'],
      env: { API_KEY: 'x' },
      envVars: ['API_KEY'],
      cwd: '/tmp',
    });

    await providerMcpService.upsertProviderMcpServer('codex', {
      name: 'codex-project-http',
      scope: 'project',
      transport: 'http',
      url: 'https://codex.example.com/mcp',
      headers: { 'X-Custom-Header': 'value' },
      envHttpHeaders: { 'X-API-Key': 'MY_API_KEY_ENV' },
      bearerTokenEnvVar: 'MY_API_TOKEN',
      workspacePath,
    });

    const userTomlPath = path.join(tempRoot, '.codex', 'config.toml');
    const userConfig = TOML.parse(await fs.readFile(userTomlPath, 'utf8')) as Record<string, unknown>;
    const userServers = userConfig.mcp_servers as Record<string, unknown>;
    const userStdio = userServers['codex-user-stdio'] as Record<string, unknown>;
    assert.equal(userStdio.command, 'python');

    const projectTomlPath = path.join(workspacePath, '.codex', 'config.toml');
    const projectConfig = TOML.parse(await fs.readFile(projectTomlPath, 'utf8')) as Record<string, unknown>;
    const projectServers = projectConfig.mcp_servers as Record<string, unknown>;
    const projectHttp = projectServers['codex-project-http'] as Record<string, unknown>;
    assert.equal(projectHttp.url, 'https://codex.example.com/mcp');

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('codex', {
        name: 'codex-local',
        scope: 'local',
        transport: 'stdio',
        command: 'node',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_SCOPE_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('codex', {
        name: 'codex-sse',
        scope: 'project',
        transport: 'sse',
        url: 'https://example.com/sse',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_TRANSPORT_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers OpenCode MCP support for user/project config files, JSONC-compatible
 * reads, and validation for unsupported scope/transport combinations.
 */
test('providerMcpService handles opencode MCP config and capability validation', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-opencode-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(path.join(tempRoot, '.config', 'opencode'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, '.config', 'opencode', 'opencode.jsonc'),
    `{
      // Existing comments should not block OpenCode MCP reads.
      "mcp": { "timeout": { "execution": 90000 } }
    }\n`,
    'utf8',
  );

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('opencode', {
      name: 'opencode-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'x' },
    });

    await providerMcpService.upsertProviderMcpServer('opencode', {
      name: 'opencode-project-http',
      scope: 'project',
      transport: 'http',
      url: 'https://opencode.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      workspacePath,
    });

    const userConfig = await readJson(path.join(tempRoot, '.config', 'opencode', 'opencode.jsonc'));
    const userServers = (userConfig.mcp as Record<string, unknown>).servers as Record<string, unknown>;
    const userStdio = userServers['opencode-user-stdio'] as Record<string, unknown>;
    assert.deepEqual((userConfig.mcp as Record<string, unknown>).timeout, { execution: 90000 });
    assert.equal(userStdio.disabled, false);
    assert.equal(userStdio.enabled, undefined);
    assert.equal(userStdio.type, 'local');
    assert.deepEqual(userStdio.command, ['node', 'server.js']);
    assert.deepEqual(userStdio.environment, { API_KEY: 'x' });

    const projectConfig = await readJson(path.join(workspacePath, 'opencode.json'));
    const projectServers = (projectConfig.mcp as Record<string, unknown>).servers as Record<string, unknown>;
    const projectHttp = projectServers['opencode-project-http'] as Record<string, unknown>;
    assert.equal(projectHttp.type, 'remote');
    assert.equal(projectHttp.url, 'https://opencode.example.com/mcp');

    const grouped = await providerMcpService.listProviderMcpServers('opencode', { workspacePath });
    assert.ok(grouped.user.some((server) => server.name === 'opencode-user-stdio' && server.transport === 'stdio'));
    assert.ok(grouped.project.some((server) => server.name === 'opencode-project-http' && server.transport === 'http'));

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('opencode', {
        name: 'opencode-local',
        scope: 'local',
        transport: 'stdio',
        command: 'node',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_SCOPE_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('opencode', {
        name: 'opencode-sse',
        scope: 'project',
        transport: 'sse',
        url: 'https://example.com/sse',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_TRANSPORT_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers Cursor MCP JSON format and user/project scope persistence.
 */
test('providerMcpService handles cursor MCP JSON config formats', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-gc-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('cursor', {
      name: 'cursor-stdio',
      scope: 'project',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-server'],
      env: { API_KEY: 'value' },
      workspacePath,
    });

    await providerMcpService.upsertProviderMcpServer('cursor', {
      name: 'cursor-http',
      scope: 'user',
      transport: 'http',
      url: 'http://localhost:3333/mcp',
      headers: { API_KEY: 'value' },
    });

    const cursorUserConfig = await readJson(path.join(tempRoot, '.cursor', 'mcp.json'));
    const cursorHttpServer = (cursorUserConfig.mcpServers as Record<string, unknown>)['cursor-http'] as Record<string, unknown>;
    assert.equal(cursorHttpServer.url, 'http://localhost:3333/mcp');
    assert.equal(cursorHttpServer.type, undefined);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers the global MCP adder requirement: only http/stdio are allowed and
 * one payload is written to all providers.
 */
test('providerMcpService global adder writes to all providers and rejects unsupported transports', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-global-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const globalResult = await providerMcpService.addMcpServerToAllProviders({
      name: 'global-http',
      scope: 'project',
      transport: 'http',
      url: 'https://global.example.com/mcp',
      workspacePath,
    });

    assert.equal(globalResult.length, 4);
    assert.ok(globalResult.every((entry) => entry.created === true));

    const claudeProject = await readJson(path.join(workspacePath, '.mcp.json'));
    assert.ok((claudeProject.mcpServers as Record<string, unknown>)['global-http']);

    const codexProject = TOML.parse(await fs.readFile(path.join(workspacePath, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>;
    assert.ok((codexProject.mcp_servers as Record<string, unknown>)['global-http']);

    const opencodeProject = await readJson(path.join(workspacePath, 'opencode.json'));
    assert.ok(((opencodeProject.mcp as Record<string, unknown>).servers as Record<string, unknown>)['global-http']);

    const cursorProject = await readJson(path.join(workspacePath, '.cursor', 'mcp.json'));
    assert.ok((cursorProject.mcpServers as Record<string, unknown>)['global-http']);

    await assert.rejects(
      providerMcpService.addMcpServerToAllProviders({
        name: 'global-sse',
        scope: 'project',
        transport: 'sse',
        url: 'https://example.com/sse',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_GLOBAL_MCP_TRANSPORT' &&
        error.statusCode === 400,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});


test('OpenCode discovers XDG, ancestor and .opencode sources with JSONC precedence and edits their origin', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-config-discovery-'));
  const workspacePath = path.join(root, 'project', 'nested');
  const configRoot = path.join(root, 'xdg');
  const globalFile = path.join(configRoot, 'opencode', 'opencode.jsonc');
  const ancestorFile = path.join(root, 'project', 'opencode.json');
  const localFile = path.join(workspacePath, '.opencode', 'opencode.jsonc');
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configRoot;
  const remote = (url: string) => ({ type: 'remote', url });
  try {
    await fs.mkdir(path.dirname(globalFile), { recursive: true });
    await fs.mkdir(path.dirname(localFile), { recursive: true });
    await fs.writeFile(globalFile, JSON.stringify({ mcp: { servers: { global: remote('https://global.invalid') } } }));
    await fs.writeFile(ancestorFile, JSON.stringify({ mcp: { servers: { inherited: remote('https://parent.invalid'), duplicate: remote('https://old.invalid') } } }));
    await fs.writeFile(localFile, JSON.stringify({ default_agent: 'review', mcp: { servers: { duplicate: remote('https://new.invalid') } } }));
    const grouped = await providerMcpService.listProviderMcpServers('opencode', { workspacePath });
    assert.equal(grouped.user.find((s) => s.name === 'global')?.sourcePath, globalFile);
    assert.equal(grouped.project.find((s) => s.name === 'inherited')?.sourcePath, ancestorFile);
    assert.equal(grouped.project.find((s) => s.name === 'duplicate')?.url, 'https://new.invalid');
    await providerMcpService.upsertProviderMcpServer('opencode', { name: 'duplicate', scope: 'project', transport: 'http', url: 'https://edited.invalid', workspacePath });
    assert.equal((await readJson(localFile)).default_agent, 'review');
    await providerMcpService.removeProviderMcpServer('opencode', { name: 'duplicate', scope: 'project', workspacePath });
    const after = await providerMcpService.listProviderMcpServers('opencode', { workspacePath });
    assert.equal(after.project.some((s) => s.name === 'duplicate'), false);
    assert.ok(after.project.some((s) => s.name === 'inherited'));
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('OpenCode MCP reads and mutates only OPENCODE_CONFIG_DIR when it overrides XDG', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-mcp-override-'));
  const before = { OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.OPENCODE_CONFIG_DIR = path.join(root, 'override');
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
  const config = path.join(process.env.OPENCODE_CONFIG_DIR, 'opencode.jsonc');
  const ignored = path.join(process.env.XDG_CONFIG_HOME, 'opencode/opencode.json');
  try {
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.mkdir(path.dirname(ignored), { recursive: true });
    await fs.writeFile(config, JSON.stringify({ mcp: { servers: { sample: { type: 'remote', url: 'https://native.invalid' } } } }));
    await fs.writeFile(ignored, '{}');
    const list = await providerMcpService.listProviderMcpServers('opencode', { workspacePath: root });
    assert.equal(list.user[0].sourcePath, config);
    await providerMcpService.upsertProviderMcpServer('opencode', { name: 'sample', scope: 'user', transport: 'http', url: 'https://edited.invalid', workspacePath: root });
    assert.match(await fs.readFile(config, 'utf8'), /edited.invalid/);
    await providerMcpService.removeProviderMcpServer('opencode', { name: 'sample', scope: 'user', workspacePath: root });
    assert.doesNotMatch(await fs.readFile(config, 'utf8'), /sample/);
    assert.equal(await fs.readFile(ignored, 'utf8'), '{}');
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * The settings UI shows one row per server name with each provider's copy
 * marked present, absent or unsupported, and flags copies whose common fields
 * disagree. Project and local scopes need a workspace; `local` is Claude-only.
 */
test('providerMcpService aggregates one row per name across providers with presence and drift', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-aggregate-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'shared', scope: 'user', transport: 'http', url: 'https://a.example/mcp',
    });
    await providerMcpService.upsertProviderMcpServer('codex', {
      name: 'shared', scope: 'user', transport: 'http', url: 'https://b.example/mcp', bearerTokenEnvVar: 'TOKEN',
    });
    await providerMcpService.upsertProviderMcpServer('cursor', {
      name: 'shared', scope: 'user', transport: 'http', url: 'https://a.example/mcp',
    });
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'cloudcli-browser', scope: 'user', transport: 'stdio', command: 'node',
    });
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'only-local', scope: 'local', transport: 'stdio', command: 'node', workspacePath,
    });

    const withoutWorkspace = await providerMcpService.listAggregatedMcpServers();
    assert.deepEqual(withoutWorkspace.project, []);
    assert.deepEqual(withoutWorkspace.local, []);
    assert.deepEqual(withoutWorkspace.user.map((row) => row.name), ['cloudcli-browser', 'shared']);

    const shared = withoutWorkspace.user.find((row) => row.name === 'shared');
    assert.ok(shared);
    assert.equal(shared.managed, false);
    assert.equal(shared.workspacePath, undefined);
    // Registry order (claude first) picks the reference copy.
    assert.equal(shared.definition.url, 'https://a.example/mcp');
    assert.deepEqual(shared.providers, {
      claude: { presence: 'present', differs: false },
      codex: { presence: 'present', differs: true },
      cursor: { presence: 'present', differs: false },
      opencode: { presence: 'absent', differs: false },
    });
    assert.equal(shared.hasDrift, true);
    assert.equal(withoutWorkspace.user.find((row) => row.name === 'cloudcli-browser')?.managed, true);

    const withWorkspace = await providerMcpService.listAggregatedMcpServers({ workspacePath });
    const onlyLocal = withWorkspace.local.find((row) => row.name === 'only-local');
    assert.ok(onlyLocal);
    assert.equal(onlyLocal.workspacePath, workspacePath);
    assert.equal(onlyLocal.providers.claude.presence, 'present');
    assert.equal(onlyLocal.providers.codex.presence, 'unsupported');
    assert.equal(onlyLocal.providers.cursor.presence, 'unsupported');
    assert.equal(onlyLocal.providers.opencode.presence, 'unsupported');
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * A fan-out save is desired state: listed providers get the definition,
 * unlisted ones lose their copy, and a renamed entry's old name is removed
 * everywhere. One adapter refusing the definition does not stop the others.
 */
test('providerMcpService fan-out save writes listed providers, removes the rest and drops the previous name', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-fanout-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('opencode', {
      name: 'tool', scope: 'project', transport: 'stdio', command: 'old', workspacePath,
    });

    const results = await providerMcpService.saveMcpServerToProviders({
      name: 'tool',
      scope: 'project',
      workspacePath,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'tool-server'],
      providers: ['claude', 'codex'],
    });
    assert.deepEqual(results, [
      { provider: 'claude', action: 'saved' },
      { provider: 'codex', action: 'saved' },
      { provider: 'cursor', action: 'unchanged' },
      { provider: 'opencode', action: 'removed' },
    ]);

    const aggregated = await providerMcpService.listAggregatedMcpServers({ workspacePath });
    const tool = aggregated.project.find((row) => row.name === 'tool');
    assert.ok(tool);
    assert.equal(tool.providers.claude.presence, 'present');
    assert.equal(tool.providers.codex.presence, 'present');
    assert.equal(tool.providers.cursor.presence, 'absent');
    assert.equal(tool.providers.opencode.presence, 'absent');

    // Rename: the new name lands first, then the old one goes from every provider.
    await providerMcpService.saveMcpServerToProviders({
      name: 'tool-renamed',
      previousName: 'tool',
      scope: 'project',
      workspacePath,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'tool-server'],
      providers: ['claude', 'codex'],
    });
    const afterRename = await providerMcpService.listAggregatedMcpServers({ workspacePath });
    assert.deepEqual(afterRename.project.map((row) => row.name), ['tool-renamed']);

    // SSE is Claude-only: the other listed provider reports its refusal and Claude still gets the copy.
    const sseResults = await providerMcpService.saveMcpServerToProviders({
      name: 'events',
      scope: 'user',
      transport: 'sse',
      url: 'https://events.example/sse',
      providers: ['claude', 'cursor'],
    });
    assert.equal(sseResults.find((entry) => entry.provider === 'claude')?.error, undefined);
    assert.match(sseResults.find((entry) => entry.provider === 'cursor')?.error ?? '', /does not support "sse"/);

    const removed = await providerMcpService.removeMcpServerFromAllProviders({ name: 'events', scope: 'user' });
    assert.equal(removed.find((entry) => entry.provider === 'claude')?.removed, true);
    assert.equal(removed.every((entry) => entry.error === undefined), true);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
