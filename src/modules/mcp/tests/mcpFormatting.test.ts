import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { McpCapabilitiesByProvider } from '@/modules/mcp/hooks/useMcpCapabilities';
import { createMcpPayloadFromForm, getProviderRejection, getSupportedFields } from '@/modules/mcp/utils/mcpFormatting';
import type { McpFormState } from '@/shared/types';

// Mirrors the backend capability matrix the page loads from /api/providers/capabilities.
const capabilities: McpCapabilitiesByProvider = {
  claude: { scopes: ['user', 'local', 'project'], transports: ['stdio', 'http', 'sse'], fields: [] },
  cursor: { scopes: ['user', 'project'], transports: ['stdio', 'http'], fields: ['cwd'] },
  codex: { scopes: ['user', 'project'], transports: ['stdio', 'http'], fields: ['cwd', 'envVars', 'bearerTokenEnvVar', 'envHttpHeaders'] },
  opencode: { scopes: ['user', 'project'], transports: ['stdio', 'http'], fields: [] },
};

const form = (overrides: Partial<McpFormState> = {}): McpFormState => ({
  name: ' tool ',
  scope: 'user',
  workspacePath: '',
  providers: ['claude', 'codex'],
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'tool'],
  env: { TOKEN: 'x' },
  cwd: '/srv',
  url: '',
  headers: {},
  envVars: ['TOKEN'],
  bearerTokenEnvVar: '',
  envHttpHeaders: {},
  importMode: 'form',
  jsonInput: '',
  ...overrides,
});

test('a stdio save carries the Codex-only fields only while Codex is among the providers', () => {
  const withCodex = createMcpPayloadFromForm(form(), capabilities);
  assert.equal(withCodex.name, 'tool');
  assert.deepEqual(withCodex.providers, ['claude', 'codex']);
  assert.equal(withCodex.cwd, '/srv');
  assert.deepEqual(withCodex.envVars, ['TOKEN']);
  assert.equal(withCodex.url, undefined);
  assert.equal(withCodex.headers, undefined);

  const claudeOnly = createMcpPayloadFromForm(form({ providers: ['claude'] }), capabilities);
  assert.equal(claudeOnly.cwd, undefined);
  assert.equal(claudeOnly.envVars, undefined);
});

test('a provider that cannot hold the scope or transport rejects the save with the caller\'s message', () => {
  assert.throws(
    () => createMcpPayloadFromForm(form({ transport: 'sse', url: 'https://x/sse', providers: ['claude', 'cursor'] }), capabilities, {
      rejectionMessage: (rejection) => `${rejection.provider}:${rejection.reason}`,
    }),
    /cursor:transport/,
  );
  assert.throws(
    () => createMcpPayloadFromForm(form({ scope: 'local', workspacePath: '/w', providers: ['codex'] }), capabilities, {
      rejectionMessage: (rejection) => `${rejection.provider}:${rejection.reason}`,
    }),
    /codex:scope/,
  );
  assert.throws(() => createMcpPayloadFromForm(form({ providers: [] }), capabilities), /at least one provider/);
  assert.deepEqual(getProviderRejection('opencode', 'local', 'stdio', capabilities), { provider: 'opencode', reason: 'scope' });
  assert.equal(getProviderRejection('claude', 'local', 'sse', capabilities), null);
});

test('pasted JSON accepts Codex snake_case fields and keeps them only for providers that store them', () => {
  const jsonInput = JSON.stringify({
    type: 'http',
    url: 'https://api.example/mcp',
    http_headers: { 'X-Key': 'k' },
    bearer_token_env_var: 'MCP_TOKEN',
    env_http_headers: { Authorization: 'AUTH_ENV' },
  });
  const payload = createMcpPayloadFromForm(form({ importMode: 'json', jsonInput, providers: ['codex', 'opencode'] }), capabilities);
  assert.equal(payload.transport, 'http');
  assert.deepEqual(payload.headers, { 'X-Key': 'k' });
  assert.equal(payload.bearerTokenEnvVar, 'MCP_TOKEN');
  assert.deepEqual(payload.envHttpHeaders, { Authorization: 'AUTH_ENV' });

  assert.deepEqual([...getSupportedFields(['claude', 'cursor'], capabilities)], ['cwd']);
});
