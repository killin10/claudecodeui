import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import type { ProjectSession } from '@/shared/types';

const response = (data: unknown = null) => Promise.resolve({ ok: true, json: async () => ({ success: true, data }) });
vi.mock('@/shared/api', () => ({ api: {
  user: { savePreferences: () => response() },
  providers: {
    models: () => response(), capabilities: () => response(), sessionActiveModel: () => response(),
  },
} }));

function renderState(session: ProjectSession | null = null) {
  return renderHook(({ selectedSession }) => useChatProviderState({ selectedSession, selectedProject: null }),
    { initialProps: { selectedSession: session } });
}

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  writeUserPreference('selectedProvider', 'codex');
});
afterEach(() => { resetUserPreferences(); localStorage.clear(); });

test('Codex global default wins over another conversation last mode', async () => {
  localStorage.setItem('permissionMode-last-codex', 'default');
  writeUserPreference('codexPermissions', { permissionMode: 'bypassPermissions' });
  const view = renderState({ id: 'unconfigured', __provider: 'codex' });
  await waitFor(() => expect(view.result.current.permissionMode).toBe('bypassPermissions'));
});

test('an explicit session default wins over the global bypass setting and survives reload', async () => {
  writeUserPreference('codexPermissions', { permissionMode: 'bypassPermissions' });
  const session = { id: 'chosen', __provider: 'codex' as const };
  const view = renderState(session);
  await waitFor(() => expect(view.result.current.permissionMode).toBe('bypassPermissions'));
  act(() => view.result.current.selectPermissionMode('default'));
  view.unmount();
  const reopened = renderState(session);
  await waitFor(() => expect(reopened.result.current.permissionMode).toBe('default'));
});

test('preference hydration updates an inherited default but preserves an explicit draft choice', async () => {
  const view = renderState();
  await waitFor(() => expect(view.result.current.providerModelsLoading).toBe(false));
  act(() => writeUserPreference('codexPermissions', { permissionMode: 'bypassPermissions' }));
  expect(view.result.current.permissionMode).toBe('bypassPermissions');
  act(() => view.result.current.selectPermissionMode('default'));
  act(() => writeUserPreference('codexPermissions', { permissionMode: 'acceptEdits' }));
  expect(view.result.current.permissionMode).toBe('default');
  view.rerender({ selectedSession: { id: 'another', __provider: 'codex' } });
  await waitFor(() => expect(view.result.current.permissionMode).toBe('acceptEdits'));
});

test.each([undefined, { permissionMode: 'invalid' }])('unconfigured or invalid defaults use the system policy', async settings => {
  localStorage.setItem('permissionMode-last-codex', 'bypassPermissions');
  if (settings) writeUserPreference('codexPermissions', settings);
  const view = renderState();
  await waitFor(() => expect(view.result.current.providerModelsLoading).toBe(false));
  expect(view.result.current.permissionMode).toBe('default');
});

test('a draft choice remains selected while provider capabilities hydrate', async () => {
  const view = renderState();
  act(() => view.result.current.selectPermissionMode('plan'));
  await waitFor(() => expect(view.result.current.providerModelsLoading).toBe(false));
  expect(view.result.current.permissionMode).toBe('plan');
});
