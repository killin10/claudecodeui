import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import McpServers from '@/modules/mcp/McpServers';
import type { AggregatedMcpServer, McpScope } from '@/shared/types';

/**
 * The MCP settings page is one list across every coding agent: a row per
 * server name, a chip per agent showing whether it holds a copy. Chips write
 * or remove that one agent's copy; Delete removes the row from every agent.
 */

type Call = { name: string; args: unknown[] };
const calls: Call[] = [];
let scopes: Record<McpScope, AggregatedMcpServer[]> = { user: [], project: [], local: [] };

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const record = (name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    return json({ results: [] });
  };
  return {
    ...actual,
    api: {
      providers: {
        capabilities: async () => json({
          providers: [
            { provider: 'claude', mcp: { scopes: ['user', 'local', 'project'], transports: ['stdio', 'http', 'sse'], fields: [] } },
            { provider: 'cursor', mcp: { scopes: ['user', 'project'], transports: ['stdio', 'http'], fields: ['cwd'] } },
            { provider: 'codex', mcp: { scopes: ['user', 'project'], transports: ['stdio', 'http'], fields: ['cwd', 'envVars', 'bearerTokenEnvVar', 'envHttpHeaders'] } },
            { provider: 'opencode', mcp: { scopes: ['user', 'project'], transports: ['stdio', 'http'], fields: [] } },
          ],
        }),
        aggregatedMcpServers: async (...args: unknown[]) => {
          calls.push({ name: 'aggregated', args });
          return json({ scopes });
        },
        saveMcpServer: record('saveMcpServer'),
        deleteMcpServer: record('deleteMcpServer'),
        saveMcpServerToProviders: record('saveToProviders'),
        deleteMcpServerFromAllProviders: record('deleteEverywhere'),
      },
    },
  };
});

const row = (overrides: Partial<AggregatedMcpServer>): AggregatedMcpServer => ({
  name: 'shared',
  scope: 'user',
  definition: { transport: 'http', url: 'https://a.example/mcp', headers: {} },
  providers: {
    claude: { presence: 'present', differs: false },
    cursor: { presence: 'present', differs: false },
    codex: { presence: 'present', differs: true },
    opencode: { presence: 'absent', differs: false },
  },
  hasDrift: true,
  managed: false,
  ...overrides,
});

const projects = [{ projectId: 'p1', displayName: 'Alpha', path: '/work/alpha' }];

const renderPage = () => render(<McpServers currentProjects={projects} />);

const chip = (rowElement: HTMLElement, provider: string) => within(rowElement).getByRole('switch', { name: provider });

beforeEach(() => {
  calls.length = 0;
  scopes = {
    user: [row({}), row({ name: 'cloudcli-browser', managed: true, hasDrift: false, definition: { transport: 'stdio', command: 'node' } })],
    project: [row({ name: 'repo-tool', scope: 'project', workspacePath: '/work/alpha', hasDrift: false, providers: {
      claude: { presence: 'present', differs: false },
      cursor: { presence: 'absent', differs: false },
      codex: { presence: 'absent', differs: false },
      opencode: { presence: 'absent', differs: false },
    } })],
    local: [row({ name: 'claude-only', scope: 'local', workspacePath: '/work/alpha', hasDrift: false, providers: {
      claude: { presence: 'present', differs: false },
      cursor: { presence: 'unsupported', differs: false },
      codex: { presence: 'unsupported', differs: false },
      opencode: { presence: 'unsupported', differs: false },
    } })],
  };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('the user view lists one row per server with a chip per agent and flags drifted copies', async () => {
  renderPage();
  const shared = (await screen.findByText('shared')).closest('div.rounded-lg') as HTMLElement;

  assert.equal(chip(shared, 'Claude').getAttribute('aria-checked'), 'true');
  assert.equal(chip(shared, 'OpenCode').getAttribute('aria-checked'), 'false');
  assert.ok(within(shared).getByText('Differs'));
  assert.match(chip(shared, 'Codex').getAttribute('title') ?? '', /different copy/);

  // Managed rows have no edit or delete buttons and their chips are inert.
  const managed = screen.getByText('cloudcli-browser').closest('div.rounded-lg') as HTMLElement;
  assert.equal(within(managed).queryByRole('button', { name: 'Delete server' }), null);
  assert.equal((chip(managed, 'Claude') as HTMLButtonElement).disabled, true);
});

test('a chip writes or removes that one agent\'s copy, and the last copy is guarded', async () => {
  renderPage();
  const shared = (await screen.findByText('shared')).closest('div.rounded-lg') as HTMLElement;

  fireEvent.click(chip(shared, 'OpenCode'));
  await waitFor(() => assert.ok(calls.some((call) => call.name === 'saveMcpServer')));
  const save = calls.find((call) => call.name === 'saveMcpServer');
  assert.equal(save?.args[0], 'opencode');
  assert.deepEqual(save?.args[1], {
    transport: 'http', url: 'https://a.example/mcp', headers: {}, name: 'shared', scope: 'user', workspacePath: undefined,
  });

  fireEvent.click(chip(shared, 'Cursor'));
  await waitFor(() => assert.ok(calls.some((call) => call.name === 'deleteMcpServer')));
  assert.deepEqual(calls.find((call) => call.name === 'deleteMcpServer')?.args, ['cursor', 'shared', { scope: 'user', workspacePath: undefined }]);

  // claude-only rows: the sole present chip cannot be unticked; Delete is the way out.
  fireEvent.click(screen.getByRole('button', { name: 'Project' }));
  const claudeOnly = (await screen.findByText('claude-only')).closest('div.rounded-lg') as HTMLElement;
  assert.equal((chip(claudeOnly, 'Claude') as HTMLButtonElement).disabled, true);
  assert.equal((chip(claudeOnly, 'Codex') as HTMLButtonElement).disabled, true);

  fireEvent.click(within(claudeOnly).getByRole('button', { name: 'Delete server' }));
  await waitFor(() => assert.ok(calls.some((call) => call.name === 'deleteEverywhere')));
  assert.deepEqual(calls.find((call) => call.name === 'deleteEverywhere')?.args, ['claude-only', { scope: 'local', workspacePath: '/work/alpha' }]);
});

test('the project view loads the selected workspace and shows its project and Claude-local rows', async () => {
  renderPage();
  await screen.findByText('shared');
  assert.deepEqual(calls.filter((call) => call.name === 'aggregated').at(-1)?.args, [{}]);

  fireEvent.click(screen.getByRole('button', { name: 'Project' }));
  await screen.findByText('repo-tool');
  assert.deepEqual(calls.filter((call) => call.name === 'aggregated').at(-1)?.args, [{ workspacePath: '/work/alpha' }]);
  assert.equal(screen.queryByText('shared'), null);
  const local = screen.getByText('claude-only').closest('div.rounded-lg') as HTMLElement;
  assert.ok(within(local).getByText('Claude Local'));
});

test('the add form writes to every ticked agent and unticks agents that cannot speak the chosen transport', async () => {
  renderPage();
  await screen.findByText('shared');
  fireEvent.click(screen.getByRole('button', { name: 'Add MCP Server' }));

  const dialog = await screen.findByText('Add MCP Server', { selector: 'h3' });
  const form = dialog.closest('div.max-h-\\[90vh\\]') as HTMLElement;
  const checkbox = (name: string) => within(form).getByRole('checkbox', { name }) as HTMLButtonElement;
  // Every agent that can take a user-scoped stdio server starts ticked.
  assert.equal(checkbox('Claude').getAttribute('aria-checked'), 'true');
  assert.equal(checkbox('OpenCode').getAttribute('aria-checked'), 'true');

  fireEvent.change(within(form).getByLabelText(/Transport Type/), { target: { value: 'sse' } });
  assert.equal(checkbox('Claude').getAttribute('aria-checked'), 'true');
  assert.equal(checkbox('Codex').getAttribute('aria-checked'), 'false');
  assert.equal(checkbox('Codex').disabled, true);

  fireEvent.change(within(form).getByLabelText(/Server Name/), { target: { value: 'events' } });
  fireEvent.change(within(form).getByLabelText(/URL/), { target: { value: 'https://events.example/sse' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Add Server' }));

  await waitFor(() => assert.ok(calls.some((call) => call.name === 'saveToProviders')));
  const save = calls.find((call) => call.name === 'saveToProviders');
  assert.equal(save?.args[0], 'events');
  const payload = save?.args[1] as Record<string, unknown>;
  assert.deepEqual(payload.providers, ['claude']);
  assert.equal(payload.transport, 'sse');
  assert.equal(payload.scope, 'user');
  assert.equal(payload.previousName, undefined);
});
