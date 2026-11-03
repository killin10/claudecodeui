import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import type { Project } from '@/shared/types';

/**
 * The four per-provider default models used to be four useState slots with four
 * copy-pasted reconciliation effects and a four-branch setter. They are now one
 * Record with one loop. These tests pin the behaviour that has to survive that:
 * each provider keeps its own model, under its own storage key, and choosing a
 * model persists it.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});
const mocks = vi.hoisted(() => ({ models: vi.fn(), capabilities: vi.fn(), agent: vi.fn(),
  mutation: vi.fn(), session: vi.fn() }));

vi.mock('@/shared/api', () => ({
  api: {
    // The preference store PATCHes through api.user; it is stubbed rather than
    // exercised here, which keeps these tests about the model record.
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: mocks.models,
      capabilities: mocks.capabilities,
      opencodeSessionAgent: mocks.agent,
      sessionActiveModel: mocks.session,
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      createModel: mocks.mutation,
      updateModel: mocks.mutation,
      deleteModel: mocks.mutation,
      setCustomModelsOnly: mocks.mutation,
    },
  },
}));

const renderProviderState = async () => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession: null, selectedProject: null }),
  );
};

beforeEach(() => {
  mocks.models.mockReset().mockImplementation(() => okJson({ success: true, data: null }));
  mocks.capabilities.mockReset().mockImplementation(() => okJson({ success: true, data: null }));
  mocks.agent.mockReset().mockImplementation(() => okJson({ success: true, data: { agent: 'plan' } }));
  mocks.mutation.mockReset();
  mocks.session.mockReset().mockImplementation(() => okJson({ success: true, data: null }));
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

afterEach(() => {
  vi.resetModules();
});

test('each provider gets its own model from its own storage key', async () => {
  localStorage.setItem('claude-model', 'claude-stored');
  localStorage.setItem('cursor-model', 'cursor-stored');
  localStorage.setItem('codex-model', 'codex-stored');
  localStorage.setItem('opencode-model', 'opencode-stored');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-stored');
  });
  assert.equal(result.current.providerModels.cursor, 'cursor-stored');
  assert.equal(result.current.providerModels.codex, 'codex-stored');
  assert.equal(result.current.providerModels.opencode, 'opencode-stored');
});

test('a provider with no stored model falls back to its own default, not another provider’s', async () => {
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  const models = result.current.providerModels;
  assert.equal(
    new Set(Object.values(models)).size,
    Object.keys(models).length,
    'each provider must have a distinct default model',
  );
});

test('choosing a model persists it under that provider’s key only', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.codex);
  });
  const claudeBefore = result.current.providerModels.claude;

  act(() => {
    result.current.setStoredProviderModel('codex', 'codex-chosen');
  });

  assert.equal(result.current.providerModels.codex, 'codex-chosen');
  assert.equal(localStorage.getItem('codex-model'), 'codex-chosen');
  assert.equal(
    result.current.providerModels.claude,
    claudeBefore,
    'setting one provider must not disturb another',
  );
  assert.equal(localStorage.getItem('claude-model'), null);
});

test('setting the same model twice keeps the record identity stable', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });
  const afterFirst = result.current.providerModels;

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });

  assert.equal(
    result.current.providerModels,
    afterFirst,
    'a no-op write must not allocate a new record and wake consumers',
  );
});

test('the active provider’s model is what currentProviderModel reports', async () => {
  // The provider selection is a stored preference; the per-provider model is
  // still a plain localStorage key.
  writeUserPreference('selectedProvider', 'cursor');
  localStorage.setItem('cursor-model', 'cursor-active');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'cursor');
  });
  assert.equal(result.current.currentProviderModel, 'cursor-active');
});

test('native variants survive catalog hydration and catalog requests follow the selected project', async () => {
  writeUserPreference('selectedProvider', 'opencode');
  localStorage.setItem('opencode-model', 'project/reasoner');
  localStorage.setItem('opencode-effort', 'deep');
  const gates: Array<(response: Awaited<ReturnType<typeof okJson>>) => void> = [];
  mocks.models.mockImplementation((provider: string) => provider === 'opencode'
    ? new Promise((resolve) => gates.push(resolve)) : okJson({ success: true, data: null }));
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const first: Project = { projectId: 'first', displayName: 'First', fullPath: '/tmp/project-one' };
  const view = renderHook(({ project }) => useChatProviderState({ selectedSession: null, selectedProject: project }), {
    initialProps: { project: first },
  });
  await waitFor(() => assert.equal(gates.length, 1));
  assert.equal(view.result.current.currentProviderEffort, 'deep');
  assert.ok(mocks.models.mock.calls.some(([provider, directory]) => provider === 'opencode' && directory === first.fullPath));
  await act(async () => gates[0](await okJson({ success: true, data: { models: {
    DEFAULT: 'project/reasoner', OPTIONS: [{ value: 'project/reasoner', label: 'Reasoner', effort: { values: [{ value: 'deep' }] } }],
  } } })));
  await waitFor(() => assert.equal(view.result.current.currentProviderEffortOptions[0]?.value, 'deep'));
  assert.equal(view.result.current.currentProviderEffort, 'deep');
  view.rerender({ project: { projectId: 'second', displayName: 'Second', fullPath: '/tmp/project-two' } });
  await waitFor(() => assert.equal(gates.length, 2));
  assert.equal(view.result.current.providerModelCatalog.opencode, undefined);
  assert.equal(localStorage.getItem('opencode-effort'), 'deep');
  assert.ok(mocks.models.mock.calls.some(([provider, directory]) => provider === 'opencode' && directory === '/tmp/project-two'));
  await act(async () => gates[1](await okJson({ success: true, data: null })));
});

test('late capability hydration preserves native plan state and explicit mode choices', async () => {
  writeUserPreference('selectedProvider', 'opencode');
  let finishCapabilities!: (response: Awaited<ReturnType<typeof okJson>>) => void;
  mocks.capabilities.mockImplementation(() => new Promise((resolve) => { finishCapabilities = resolve; }));
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const view = renderHook(() => useChatProviderState({
    selectedSession: { id: 'ses_plan', __provider: 'opencode' }, selectedProject: null,
  }));
  await waitFor(() => assert.equal(view.result.current.permissionMode, 'plan'));
  await act(async () => finishCapabilities(await okJson({ success: true, data: { providers: [{
    provider: 'opencode', permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'], defaultPermissionMode: 'default',
  }] } })));
  await waitFor(() => assert.equal(mocks.agent.mock.calls.length, 2));
  assert.equal(view.result.current.permissionMode, 'plan');
  act(() => view.result.current.selectPermissionMode('default'));
  assert.equal(view.result.current.permissionMode, 'default');
  assert.equal(view.result.current.permissionModeExplicit, true);
});

for (const operation of ['create', 'update', 'remove', 'setCustomModelsOnly'] as const) {
  test(`a late ${operation} response refreshes the current project instead of replacing it`, async () => {
    writeUserPreference('selectedProvider', 'opencode');
    let changed = false;
    const catalog = (directory: string) => ({ DEFAULT: `${directory}/native`, OPTIONS: [
      { value: `${directory}/native`, label: directory },
      ...(changed ? [{ value: 'custom/model', label: 'Custom' }] : []),
    ] });
    mocks.models.mockImplementation((provider: string, directory: string) => okJson({ success: true, data: {
      models: catalog(provider === 'opencode' ? directory : provider),
    } }));
    let finish!: (response: Awaited<ReturnType<typeof okJson>>) => void;
    mocks.mutation.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
    const view = renderHook(({ directory }) => useChatProviderState({ selectedSession: null, selectedProject: {
      projectId: directory, displayName: directory, fullPath: directory,
    } }), { initialProps: { directory: '/project-a' } });
    await waitFor(() => assert.equal(view.result.current.currentProviderModel, '/project-a/native'));
    let pending!: Promise<void>;
    const existing = { value: 'custom/model', label: 'Custom', recordId: 1 };
    act(() => {
      const actions = view.result.current.providerModelActions;
      if (operation === 'create') pending = actions.create('opencode', { id: 'custom/model', model: 'Custom' });
      if (operation === 'update') pending = actions.update('opencode', existing, { id: 'custom/model', model: 'Renamed' });
      if (operation === 'remove') pending = actions.remove('opencode', existing);
      if (operation === 'setCustomModelsOnly') pending = actions.setCustomModelsOnly('opencode', false);
    });
    view.rerender({ directory: '/project-b' });
    await waitFor(() => assert.equal(view.result.current.currentProviderModel, '/project-b/native'));
    await act(async () => {
      changed = true;
      finish(await okJson({ success: true, data: { model: existing, models: catalog('/project-a') } }));
      await pending;
    });
    await waitFor(() => assert.equal(view.result.current.currentProviderModelOptions.length, 2));
    assert.equal(view.result.current.currentProviderModelOptions[0]?.value, '/project-b/native');
    assert.equal(view.result.current.currentProviderModel, '/project-b/native');
  });
}

test('a delayed model rename does not overwrite a different session in the same project', async () => {
  writeUserPreference('selectedProvider', 'opencode');
  mocks.session.mockImplementation((_provider: string, id: string) => okJson({ success: true, data: {
    model: id === 'one' ? 'custom/model' : 'other/model', source: 'session',
  } }));
  let finish!: (response: Awaited<ReturnType<typeof okJson>>) => void;
  mocks.mutation.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const view = renderHook(({ id }) => useChatProviderState({ selectedSession: { id, __provider: 'opencode' },
    selectedProject: { projectId: 'project', displayName: 'Project', fullPath: '/project' },
  }), { initialProps: { id: 'one' } });
  await waitFor(() => assert.equal(view.result.current.currentProviderModel, 'custom/model'));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.providerModelActions.update('opencode', {
    recordId: 1, value: 'custom/model', label: 'Custom',
  }, { id: 'custom/renamed', model: 'Renamed' }); });
  view.rerender({ id: 'two' });
  await waitFor(() => assert.equal(view.result.current.currentProviderModel, 'other/model'));
  await act(async () => {
    finish(await okJson({ success: true, data: { model: { value: 'custom/renamed', label: 'Renamed' },
      models: { DEFAULT: 'custom/renamed', OPTIONS: [{ value: 'custom/renamed', label: 'Renamed' }] },
    } }));
    await pending;
  });
  assert.equal(view.result.current.currentProviderModel, 'other/model');
});

test('a late global model deletion reloads the affected session in the new project', async () => {
  writeUserPreference('selectedProvider', 'opencode');
  let deleted = false;
  mocks.models.mockImplementation((_provider: string, directory: string) => okJson({ success: true, data: { models: {
    DEFAULT: `${directory}/native`, OPTIONS: [{ value: `${directory}/native`, label: directory }],
  } } }));
  mocks.session.mockImplementation((_provider: string, id: string) => okJson({ success: true, data: {
    model: deleted ? `/project-${id}/native` : 'custom/shared', source: 'session',
  } }));
  let finish!: (response: Awaited<ReturnType<typeof okJson>>) => void;
  mocks.mutation.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const view = renderHook(({ id }) => useChatProviderState({ selectedSession: { id, __provider: 'opencode' },
    selectedProject: { projectId: id, displayName: id, fullPath: `/project-${id}` },
  }), { initialProps: { id: 'a' } });
  await waitFor(() => assert.equal(view.result.current.currentProviderModel, 'custom/shared'));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.providerModelActions.remove('opencode', {
    recordId: 1, value: 'custom/shared', label: 'Shared',
  }); });
  view.rerender({ id: 'b' });
  await waitFor(() => assert.ok(mocks.session.mock.calls.some(([, id]) => id === 'b')));
  await act(async () => {
    deleted = true;
    finish(await okJson({ success: true, data: { model: { value: 'custom/shared', label: 'Shared' },
      models: { DEFAULT: '/project-a/native', OPTIONS: [{ value: '/project-a/native', label: 'A' }] },
    } }));
    await pending;
  });
  await waitFor(() => assert.equal(view.result.current.currentProviderModel, '/project-b/native'));
  assert.equal(view.result.current.currentProviderModelOptions[0]?.value, '/project-b/native');
});
