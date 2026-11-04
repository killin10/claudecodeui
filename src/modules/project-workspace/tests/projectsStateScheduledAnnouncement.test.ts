import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ServerEvent } from '@/shared/types';

/**
 * The server announces every change to a session's scheduled messages
 * (`scheduled_messages_changed`, #1546) to every open tab, including tabs
 * that are showing a different session. That announcement is not new activity
 * in the session it names, so it must not light up that session's sidebar row
 * the way a reply arriving in the background does.
 */

const BACKGROUND_SESSION_ID = 'background-session';

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'repo',
  isStarred: false,
  sessions: [{ id: BACKGROUND_SESSION_ID, summary: 'a background session' }],
  sessionMeta: { hasMore: false, total: 1 },
};

const listeners = new Set<(event: ServerEvent) => void>();

const emit = (event: ServerEvent) => {
  act(() => {
    for (const listener of listeners) {
      listener(event);
    }
  });
};

const renderProjectsState = async () => {
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  return renderHook(() =>
    useProjectsState({
      sessionId: undefined,
      navigate: vi.fn(),
      subscribe: (listener: (event: ServerEvent) => void) => {
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
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [project] });
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('a scheduled-message announcement does not mark its session as needing attention', async () => {
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.sidebarSharedProps.isLoading, false));

  emit({ kind: 'scheduled_messages_changed', sessionId: BACKGROUND_SESSION_ID, timestamp: '2026-10-19T17:22:09.000Z' });
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has(BACKGROUND_SESSION_ID), false);

  // The same session producing real output still does, so the check above
  // is not passing just because nothing can mark this session.
  emit({ kind: 'text', sessionId: BACKGROUND_SESSION_ID, content: 'DONE' });
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has(BACKGROUND_SESSION_ID), true);
});

test('opening schedules preserves selection but new replies remain unread until the session is shown again', async () => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const navigate = vi.fn();
  const { result, rerender } = renderHook(({ visible }) => useProjectsState({
    sessionId: visible ? BACKGROUND_SESSION_ID : undefined,
    isSessionViewVisible: visible,
    navigate, subscribe, isMobile: false, isSessionProcessing: () => false,
  }), { initialProps: { visible: true } });
  await waitFor(() => assert.equal(result.current.selectedSession?.id, BACKGROUND_SESSION_ID));
  rerender({ visible: false });
  assert.equal(result.current.selectedSession?.id, BACKGROUND_SESSION_ID);
  assert.equal(result.current.sidebarSharedProps.selectedSession, null);
  emit({ kind: 'text', sessionId: BACKGROUND_SESSION_ID, role: 'assistant', content: 'Background reply' });
  assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has(BACKGROUND_SESSION_ID), true);
  rerender({ visible: true });
  await waitFor(() => assert.equal(result.current.sidebarSharedProps.attentionSessionIds.has(BACKGROUND_SESSION_ID), false));
});

test.each([
  { visible: false, target: 'session' },
  { visible: false, target: 'project' },
  { visible: true, target: 'session' },
  { visible: true, target: 'project' },
])('removing a selected $target only navigates when the session view is visible ($visible)', async ({ visible, target }) => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  const navigate = vi.fn();
  const subscribe = () => () => {};
  const { result, rerender } = renderHook(({ shown }) => useProjectsState({
    sessionId: shown ? BACKGROUND_SESSION_ID : undefined,
    isSessionViewVisible: shown,
    navigate,
    subscribe,
    isMobile: false,
    isSessionProcessing: () => false,
  }), { initialProps: { shown: true } });
  await waitFor(() => assert.equal(result.current.selectedSession?.id, BACKGROUND_SESSION_ID));
  rerender({ shown: visible });
  navigate.mockClear();
  act(() => {
    if (target === 'session') {
      result.current.sidebarSharedProps.onSessionDelete(BACKGROUND_SESSION_ID);
    } else {
      result.current.sidebarSharedProps.onProjectDelete(project.projectId);
    }
  });
  assert.equal(result.current.selectedSession, null);
  assert.equal(navigate.mock.calls.length, visible ? 1 : 0);
  if (visible) assert.deepEqual(navigate.mock.calls[0], ['/']);
  if (target === 'project') assert.equal(result.current.selectedProject, null);
});
