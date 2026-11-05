import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import type { Project, RecentConversationListItem } from '@/shared/types';

/**
 * The Conversations list keeps its own copy of each session's title and is
 * fetched only when its tab opens. A session renamed from the workspace header
 * is patched straight into `projects`, so the list has to fold that title in
 * itself, or the highlighted row would keep the old name beside the new header.
 */

const recentConversationsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations: () => recentConversationsResponse(),
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as TFunction;

const conversation = (sessionId: string, sessionTitle: string): RecentConversationListItem => ({
  sessionId,
  provider: 'claude',
  projectId: 'project-1',
  projectDisplayName: 'repo',
  sessionTitle,
  lastActivity: '2026-09-22T09:30:00.000Z',
});

const buildProject = (summaries: Record<string, string>): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'repo',
  isStarred: false,
  sessions: Object.entries(summaries).map(([id, summary]) => ({ id, summary, __provider: 'claude' as const })),
  sessionMeta: { hasMore: false, total: Object.keys(summaries).length },
});

const renderController = (initialProjects: Project[]) => renderHook(
  ({ projects }: { projects: Project[] }) => useSidebarController({
    projects,
    selectedProject: null,
    selectedSession: null,
    activeSessions: new Set<string>(),
    backgroundSessionIds: new Set<string>(),
    isLoading: false,
    isMobile: false,
    t,
    onRefresh: vi.fn(),
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    setCurrentProject: vi.fn(),
    setSidebarVisible: vi.fn(),
    sidebarVisible: true,
  }),
  { initialProps: { projects: initialProjects } },
);

const openConversationsTab = async (initialProjects: Project[]) => {
  const rendered = renderController(initialProjects);
  act(() => {
    rendered.result.current.setSearchMode('conversations');
  });
  await waitFor(() => {
    assert.equal(rendered.result.current.recentConversations.length, 2);
  });
  return rendered;
};

beforeEach(() => {
  localStorage.clear();
  recentConversationsResponse.mockReset();
  recentConversationsResponse.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        conversations: [conversation('session-1', 'Original title'), conversation('session-2', 'session-2')],
        total: 2,
        hasMore: false,
      },
    }),
  });
});

test('a title renamed in `projects` lands on the matching conversation row', async () => {
  const { result, rerender } = await openConversationsTab([buildProject({ 'session-1': 'Original title', 'session-2': '' })]);

  rerender({ projects: [buildProject({ 'session-1': 'Renamed from header', 'session-2': '' })] });

  assert.deepEqual(
    result.current.recentConversations.map((row) => row.sessionTitle),
    ['Renamed from header', 'session-2'],
  );
  // No refetch was needed for the row to catch up.
  assert.equal(recentConversationsResponse.mock.calls.length, 1);
});

test('rows keep their identity, and an unnamed session keeps its id, when nothing was renamed', async () => {
  const { result, rerender } = await openConversationsTab([buildProject({ 'session-1': 'Original title', 'session-2': '' })]);
  const rowsBefore = result.current.recentConversations;

  rerender({ projects: [buildProject({ 'session-1': 'Original title', 'session-2': '' })] });

  assert.equal(result.current.recentConversations, rowsBefore);
});

test('live deltas add, reorder and remove conversations without fetching the feed', async () => {
  let listener: (event: any) => void = () => {};
  const subscribe = (fn: typeof listener) => { listener = fn; return () => {}; };
  const projects: Project[] = [];
  const { result } = renderHook(() => useSidebarController({
    subscribe, projects, selectedProject: null, selectedSession: null,
    activeSessions: new Set<string>(), backgroundSessionIds: new Set<string>(),
    isLoading: false, isMobile: false, t, onRefresh: vi.fn(), onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(), setCurrentProject: vi.fn(), setSidebarVisible: vi.fn(), sidebarVisible: true,
  }));
  await waitFor(() => assert.equal(result.current.recentConversations.length, 2));
  const calls = recentConversationsResponse.mock.calls.length;
  act(() => listener({ kind: 'session_upserted', sessionId: 'fresh', provider: 'opencode', total: 3,
    project: { projectId: 'project-1', displayName: 'repo' },
    session: { id: 'fresh', summary: 'New session', lastActivity: '2026-11-05T00:00:00Z' } }));
  assert.equal(result.current.recentConversations[0].sessionId, 'fresh');
  assert.equal(result.current.recentConversationsTotal, 3);
  act(() => listener({ kind: 'session_upserted', sessionId: 'fresh', provider: 'opencode', total: 3,
    project: { projectId: 'project-1', displayName: 'repo' },
    session: { id: 'fresh', summary: 'Renamed', lastActivity: '2026-11-05T00:01:00Z' } }));
  assert.equal(result.current.recentConversations.length, 3);
  assert.equal(result.current.recentConversations[0].sessionTitle, 'Renamed');
  act(() => listener({ kind: 'session_removed', sessionId: 'fresh', total: 2 }));
  assert.equal(result.current.recentConversations.length, 2);
  assert.equal(result.current.recentConversationsTotal, 2);
  assert.equal(recentConversationsResponse.mock.calls.length, calls);

  // A reconnect snapshot arriving after a live deletion must not resurrect it.
  const staleResponse = { ok: true, json: async () => ({ data: {
    conversations: [conversation('session-1', 'Original title'), conversation('session-2', 'session-2')], total: 2,
  } }) };
  let resolveSnapshot!: (response: typeof staleResponse) => void;
  recentConversationsResponse.mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve; }));
  act(() => listener({ kind: 'websocket_reconnected' }));
  act(() => listener({ kind: 'session_removed', sessionId: 'session-1', total: 1 }));
  await act(async () => { resolveSnapshot(staleResponse); });
  assert.deepEqual(result.current.recentConversations.map(row => row.sessionId), ['session-2']);
  assert.equal(result.current.recentConversationsTotal, 1);
});
