import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import type * as SharedApi from '@/shared/api';
import { OpenCodePermissionRecovery } from '@/modules/chat/modals/OpenCodePermissionRecovery';
import '@/modules/i18n';

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('@/shared/api', async (original) => {
  const actual = await original<typeof SharedApi>();
  return { ...actual, api: { ...actual.api, providers: { ...actual.api.providers,
    opencodeSettingsPermissions: mocks.load, saveOpenCodeSettingsPermissions: mocks.save,
  } } };
});
const settings = {
  directory: '/project', editable: { path: '/fixture/opencode.json', revision: 'rev1', rules: [{ action: 'shell', resource: 'pwd', effect: 'deny' }] },
  sources: [{ path: '/project/opencode.json', rules: [{ action: 'edit', resource: '*', effect: 'deny' }], agents: [] }], saved: [],
};
const success = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
beforeEach(() => {
  mocks.load.mockReset().mockImplementation(() => Promise.resolve(success(settings)));
  mocks.save.mockReset().mockImplementation(() => Promise.resolve(success({})));
});

test('only a structured native denial opens project-scoped rules; grants require an explicit save', async () => {
  render(<OpenCodePermissionRecovery workspacePath="/project" result={{ isError: true, errorType: 'permission.rejected', content: 'Permission denied: shell' }} />);
  expect(mocks.load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Review OpenCode permissions' }));
  expect(await screen.findByText('/fixture/opencode.json', {}, { timeout: 5000 })).toBeTruthy();
  expect(mocks.load).toHaveBeenCalledWith('/project');
  expect(screen.queryByLabelText('Inspect rules for')).toBeNull();
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Effect 1'), { target: { value: 'allow' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save user rules' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ revision: 'rev1', rules: [{ action: 'shell', resource: 'pwd', effect: 'allow' }] }));
});

test.each([
  { isError: true, errorType: 'tool.execution', content: 'Permission denied: shell' },
  { isError: true, content: 'EACCES: permission denied' },
  { isError: true, errorType: 'provider.auth', content: 'invalid key' },
  { isError: false, errorType: 'permission.rejected', content: 'ok' },
])('does not offer agent permission changes for other failures: %j', (result) => {
  render(<OpenCodePermissionRecovery workspacePath="/project" result={result} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(mocks.load).not.toHaveBeenCalled();
});
