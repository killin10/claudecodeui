import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * Regression guard for the `session_upserted` alias rewrite.
 *
 * A session indexed from a transcript on disk is keyed by the provider-native
 * id until the run reports that id back and the two rows are merged. The
 * `providerSessionId` field on the delta is the only signal the client gets
 * that the row it is showing has been merged away — without it the sidebar
 * keeps a duplicate and the URL points at an id no session row has.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const PROVIDER_SESSION_ID = 'native-1';
const APP_SESSION_ID = 'app-1';

const buildProject = (sessions: ProjectSession[]): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions,
  sessionMeta: { hasMore: false, total: sessions.length },
});

const respondWith = (projects: Project[]) => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => projects });
};

type ServerEventListener = (event: Record<string, unknown>) => void;

const listeners = new Set<ServerEventListener>();

const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const buildUpsert = (providerSessionId: string | null) => ({
  kind: 'session_upserted',
  sessionId: APP_SESSION_ID,
  providerSessionId,
  provider: 'opencode',
  session: {
    id: APP_SESSION_ID,
    summary: 'merged session',
    messageCount: 0,
    lastActivity: '2026-01-01T00:00:00.000Z',
  },
  project: {
    projectId: 'project-1',
    path: '/repo',
    fullPath: '/repo',
    displayName: 'Repo',
    isStarred: false,
  },
  timestamp: '2026-01-01T00:00:00.000Z',
});

const renderProjectsState = async (navigate: ReturnType<typeof vi.fn>, urlSessionId: string) => {
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  return renderHook(() =>
    useProjectsState({
      sessionId: urlSessionId,
      navigate: navigate as never,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('an upsert carrying the provider id replaces the aliased row and rewrites the url', async () => {
  respondWith([buildProject([
    { id: PROVIDER_SESSION_ID, summary: 'indexed from disk' } as ProjectSession,
  ])]);
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate, PROVIDER_SESSION_ID);

  await waitFor(() => {
    assert.equal(result.current.projects[0]?.sessions?.[0]?.id, PROVIDER_SESSION_ID);
  });

  act(() => {
    result.current.handleSessionSelect({ id: PROVIDER_SESSION_ID } as ProjectSession);
  });
  navigate.mockClear();

  await act(async () => {
    emit(buildUpsert(PROVIDER_SESSION_ID));
  });

  assert.deepEqual(
    (result.current.projects[0]?.sessions ?? []).map((session) => session.id),
    [APP_SESSION_ID],
    'the provider-id row must be replaced, not duplicated',
  );
  assert.equal(result.current.selectedSession?.id, APP_SESSION_ID);
  assert.deepEqual(navigate.mock.calls, [[`/session/${APP_SESSION_ID}`]]);
});

test('an upsert without a provider id leaves the aliased row in place', async () => {
  respondWith([buildProject([
    { id: PROVIDER_SESSION_ID, summary: 'indexed from disk' } as ProjectSession,
  ])]);
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate, PROVIDER_SESSION_ID);

  await waitFor(() => {
    assert.equal(result.current.projects[0]?.sessions?.[0]?.id, PROVIDER_SESSION_ID);
  });

  act(() => {
    result.current.handleSessionSelect({ id: PROVIDER_SESSION_ID } as ProjectSession);
  });
  navigate.mockClear();

  // This is what the watcher used to send. The client cannot tell the two rows
  // are the same conversation, so both survive — the bug this field prevents.
  await act(async () => {
    emit(buildUpsert(null));
  });

  assert.deepEqual(
    (result.current.projects[0]?.sessions ?? []).map((session) => session.id).sort(),
    [APP_SESSION_ID, PROVIDER_SESSION_ID],
  );
  assert.equal(result.current.selectedSession?.id, PROVIDER_SESSION_ID);
  assert.deepEqual(navigate.mock.calls, []);
});

test('an upsert for a session that is already canonical does not renavigate', async () => {
  respondWith([buildProject([
    { id: APP_SESSION_ID, summary: 'already merged' } as ProjectSession,
  ])]);
  const navigate = vi.fn();
  // The URL already holds the canonical id, which is the steady state during
  // a run — every watcher tick now carries providerSessionId.
  const { result } = await renderProjectsState(navigate, APP_SESSION_ID);

  await waitFor(() => {
    assert.equal(result.current.projects[0]?.sessions?.[0]?.id, APP_SESSION_ID);
  });

  act(() => {
    result.current.handleSessionSelect({ id: APP_SESSION_ID } as ProjectSession);
  });
  navigate.mockClear();

  // The watcher now sends providerSessionId on every tick during a run; a
  // session already showing its canonical id must not be renavigated each time.
  await act(async () => {
    emit(buildUpsert(PROVIDER_SESSION_ID));
    emit(buildUpsert(PROVIDER_SESSION_ID));
  });

  assert.equal(result.current.selectedSession?.id, APP_SESSION_ID);
  assert.deepEqual(navigate.mock.calls, []);
});

test('metadata-only upserts update lists without marking attention or reloading chat', async () => {
  respondWith([buildProject([{ id: APP_SESSION_ID, summary: 'Before' }])]);
  const { result } = await renderProjectsState(vi.fn(), '');
  await waitFor(() => assert.equal(result.current.projects.length, 1));
  act(() => emit({ ...buildUpsert(null), metadataOnly: true }));
  assert.equal(result.current.projects[0].sessions?.[0].summary, 'merged session');
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.size, 0);
  act(() => result.current.handleSessionSelect({ id: APP_SESSION_ID } as ProjectSession));
  const before = result.current.externalMessageUpdate;
  act(() => emit({ ...buildUpsert(null), metadataOnly: true }));
  assert.equal(result.current.externalMessageUpdate, before);
});

test('an unseen existing session does not inflate the project total and removal uses server totals', async () => {
  const project = buildProject([{ id: 'first', summary: 'First' }]);
  project.sessionMeta = { total: 50, hasMore: true };
  respondWith([project]);
  const { result } = await renderProjectsState(vi.fn(), '');
  await waitFor(() => assert.equal(result.current.projects.length, 1));
  act(() => emit({ ...buildUpsert(null), projectTotal: 50 }));
  assert.equal(result.current.projects[0].sessions?.length, 2);
  assert.equal(result.current.projects[0].sessionMeta?.total, 50);
  act(() => emit({ ...buildUpsert(null), projectTotal: 51 }));
  assert.equal(result.current.projects[0].sessionMeta?.total, 51);
  act(() => emit({ kind: 'session_removed', sessionId: APP_SESSION_ID, projectId: 'project-1', projectTotal: 49 }));
  assert.equal(result.current.projects[0].sessions?.length, 1);
  assert.equal(result.current.projects[0].sessionMeta?.total, 49);
});
