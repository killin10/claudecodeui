import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { OpenCodePermissionsContent } from '@/modules/settings/tabs/agents-settings/sections/content/OpenCodePermissionsContent';
import AgentCategoryContentSection from '@/modules/settings/tabs/agents-settings/sections/AgentCategoryContentSection';
import type { OpenCodePermissionSettings } from '@/shared/types';
import type * as SharedApi from '@/shared/api';
import '@/modules/i18n';

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), change: vi.fn() }));
vi.mock('@/shared/api', async (original) => {
  const actual = await original<typeof SharedApi>();
  return { ...actual, api: { ...actual.api, providers: { ...actual.api.providers,
    opencodeSettingsPermissions: mocks.load, saveOpenCodeSettingsPermissions: mocks.save, changeOpenCodeSavedPermission: mocks.change,
  } } };
});

const settings: OpenCodePermissionSettings = {
  directory: '/home/test',
  editable: { path: '/home/test/.config/opencode/opencode.jsonc', revision: 'rev-1', rules: [{ action: 'shell', resource: 'git *', effect: 'ask' }] },
  sources: [{ path: '/project/opencode.json', rules: [{ action: 'edit', resource: '*', effect: 'deny' }], agents: [] }],
  saved: [{ id: 'saved_1', action: 'shell', resource: 'pwd' }],
};
const success = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

beforeEach(() => {
  mocks.load.mockReset().mockImplementation(async () => success(settings));
  mocks.change.mockReset().mockImplementation(async () => success({ id: 'saved_1' }));
  mocks.save.mockReset().mockImplementation(async () => success(settings.editable));
});

test('OpenCode permissions category renders its native settings panel', async () => {
  render(<AgentCategoryContentSection selectedAgent="opencode" selectedCategory="permissions" projects={[]}
    agentContextById={{} as never} claudePermissions={{} as never} cursorPermissions={{} as never}
    onClaudePermissionsChange={() => {}} onCursorPermissionsChange={() => {}} codexPermissionMode="default" onCodexPermissionModeChange={() => {}} />);
  expect(await screen.findByText(settings.editable.path)).toBeTruthy();
  expect(screen.getByText('/project/opencode.json')).toBeTruthy();
  expect(screen.getByText('shell · pwd → allow')).toBeTruthy();
});

test('rule edits save typed native rules and revision; a conflict keeps the draft', async () => {
  render(<OpenCodePermissionsContent projects={[]} />);
  await screen.findByText(settings.editable.path);
  fireEvent.change(screen.getByLabelText('Resource 1'), { target: { value: 'git status *' } });
  fireEvent.change(screen.getByLabelText('Effect 1'), { target: { value: 'allow' } });
  mocks.save.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Config changed; reload' } }), { status: 409 }));
  fireEvent.click(screen.getByRole('button', { name: 'Save user rules' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Config changed; reload');
  expect((screen.getByLabelText('Resource 1') as HTMLInputElement).value).toBe('git status *');
  expect(mocks.save).toHaveBeenCalledWith({ revision: 'rev-1', rules: [{ action: 'shell', resource: 'git status *', effect: 'allow' }] });
  fireEvent.click(screen.getByRole('button', { name: 'Save user rules' }));
  await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
});

test('source directory selection reloads project rules and load errors stay visible', async () => {
  render(<OpenCodePermissionsContent projects={[{ name: 'p1', displayName: 'Project', fullPath: '/project' }]} />);
  await screen.findByText(settings.editable.path);
  mocks.load.mockRejectedValueOnce(new Error('OpenCode unavailable'));
  fireEvent.change(screen.getByLabelText('Inspect rules for'), { target: { value: '/project' } });
  expect((await screen.findByRole('alert')).textContent).toContain('OpenCode unavailable');
  expect(mocks.load).toHaveBeenLastCalledWith('/project');
  expect(screen.queryByRole('button', { name: 'Save user rules' })).toBeNull();
});


test('saved approval edits and revocation preserve user-rule drafts, and failed changes keep the approval', async () => {
  render(<OpenCodePermissionsContent projects={[]} />);
  await screen.findByText(settings.editable.path);
  fireEvent.change(screen.getByLabelText('Resource 1'), { target: { value: 'unsaved draft' } });
  fireEvent.change(screen.getByLabelText('Resource saved_1'), { target: { value: 'git status' } });
  fireEvent.click(screen.getByRole('button', { name: 'Update approval' }));
  await screen.findByText('shell · git status → allow');
  expect(mocks.change).toHaveBeenCalledWith(expect.objectContaining({ operation: 'update', id: 'saved_1', expected: { action: 'shell', resource: 'pwd' }, rule: { action: 'shell', resource: 'git status' } }));
  mocks.change.mockRejectedValueOnce(new Error('Native host unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Revoke approval' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Native host unavailable');
  expect(screen.getByText('shell · git status → allow')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke approval' }));
  await waitFor(() => expect(screen.queryByText('shell · git status → allow')).toBeNull());
  expect((screen.getByLabelText('Resource 1') as HTMLInputElement).value).toBe('unsaved draft');
});
