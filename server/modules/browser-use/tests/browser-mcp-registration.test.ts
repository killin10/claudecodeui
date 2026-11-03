import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-mcp-registration-'));
process.env.DATABASE_PATH = path.join(home, 'auth.db');
await fs.writeFile(process.env.DATABASE_PATH, '');
const { appConfigDb, initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
const { providerMcpService } = await import('@/modules/providers/index.js');
const { browserUseService } = await import('@/modules/browser-use/browser-use.service.js');
await initializeDatabase();
test.after(async () => { closeConnection(); await fs.rm(home, { recursive: true, force: true }); });

test('startup updates enabled MCP registrations to the stable launcher and reports provider failures', async (t) => {
  const command = path.join(home, 'cloudcli');
  await fs.writeFile(command, 'fixture');
  const before = process.env.CLOUDCLI_BROWSER_USE_MCP_COMMAND;
  process.env.CLOUDCLI_BROWSER_USE_MCP_COMMAND = command;
  t.after(() => {
    if (before === undefined) delete process.env.CLOUDCLI_BROWSER_USE_MCP_COMMAND;
    else process.env.CLOUDCLI_BROWSER_USE_MCP_COMMAND = before;
  });
  t.mock.method(providerMcpService, 'removeMcpServerFromAllProviders', async () => []);
  const add = t.mock.method(providerMcpService, 'addMcpServerToAllProviders', async () => [{ provider: 'opencode', created: true }]);
  appConfigDb.set('browser_use_settings', JSON.stringify({ enabled: false }));
  await browserUseService.reconcileAgentMcp();
  assert.equal(add.mock.callCount(), 0);
  appConfigDb.set('browser_use_settings', JSON.stringify({ enabled: true }));
  await browserUseService.reconcileAgentMcp();
  const input = add.mock.calls[0].arguments[0];
  assert.ok(input);
  assert.equal(input.command, command);
  assert.deepEqual(input.args, ['browser-use-mcp']);
  assert.equal(input.name, 'cloudcli-browser');
  add.mock.mockImplementation(async () => [{ provider: 'opencode', created: false, error: 'fixture write failure' }]);
  await assert.rejects(browserUseService.reconcileAgentMcp(), /opencode: fixture write failure/);
});

test('cloudcli browser-use-mcp exposes tools with clean JSON-RPC stdout', () => {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map((message) => JSON.stringify(message) + '\n').join('');
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'server/modules/cli/cli.ts', 'browser-use-mcp'], {
    input, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: home, DATABASE_PATH: path.join(home, 'stdio.db') },
  });
  const messages = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(messages.length, 2);
  assert.equal(messages.find((message) => message.id === 1).result.serverInfo.name, 'cloudcli-browser');
  const tools = messages.find((message) => message.id === 2).result.tools;
  assert.ok(tools.some((tool: { name: string }) => tool.name === 'browser_create_session'));
});
