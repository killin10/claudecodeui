import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';
import type { Project, SessionWithProvider } from '@/shared/types';

let compact = false;
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => compact }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set() }));

const project: Project = { projectId: 'project-1', displayName: 'Long project name', fullPath: '/tmp/project-1' };
const sessions: SessionWithProvider[] = [{ id: 'session-1', summary: 'A conversation', __provider: 'opencode' }];
const t = ((key: string) => key) as TFunction;
const noop = () => {};

const props = (overrides: Partial<ComponentProps<typeof SidebarProjectItem>> = {}): ComponentProps<typeof SidebarProjectItem> => ({
  project, selectedProject: null, selectedSession: null,
  isExpanded: true, isDeleting: false, isStarred: false, isEditing: false, renameDraft: '',
  sessions, initialSessionsLoaded: true, isLoadingMoreSessions: false, currentTime: new Date(),
  sessionRenameId: null, sessionRenameDraft: '', tasksEnabled: false, mcpServerStatus: null,
  onRenameDraftChange: noop, onToggleProject: noop, onProjectSelect: noop, onToggleStarProject: noop,
  onStartEditingProject: noop, onCancelEditingProject: noop, onSaveProjectName: noop, onDeleteProject: noop,
  onSessionSelect: noop, onDeleteSession: noop, onLoadMoreSessions: noop,
  activeSessions: new Set(), backgroundSessionIds: new Set(), attentionSessionIds: new Set(),
  onNewSession: noop, onStartEditingSession: noop, onCancelEditingSession: noop, onSaveEditingSession: noop,
  selectedSessionIds: null, onSetSessionSelection: noop, onToggleSessionSelected: noop,
  onCancelSessionSelection: noop, onDeleteSelectedSessions: noop, t, ...overrides,
});

beforeEach(() => { compact = false; });

for (const layout of ['desktop', 'compact'] as const) {
  test(`${layout} header icons create and enter selection without toggling the project`, async () => {
    compact = layout === 'compact';
    const onNewSession = vi.fn();
    const onSetSessionSelection = vi.fn();
    const onToggleProject = vi.fn();
    const { container } = render(<SidebarProjectItem {...props({ onNewSession, onSetSessionSelection, onToggleProject })} />);
    const create = screen.getByRole('button', { name: 'sessions.newSession' });
    const select = screen.getByRole('button', { name: 'sessions.selectConversations' });
    assert.equal(create.textContent, '');
    assert.equal(select.textContent, '');
    assert.equal(container.querySelector('button button'), null, 'actions are independent native buttons');
    fireEvent.click(create);
    assert.deepEqual(onNewSession.mock.calls, [[project]]);
    fireEvent.click(select);
    assert.deepEqual(onSetSessionSelection.mock.calls, [[{ projectId: project.projectId, sessionIds: new Set() }]]);
    assert.equal(onToggleProject.mock.calls.length, 0);
    fireEvent.mouseEnter(create.parentElement!);
    await waitFor(() => assert.ok(screen.getByText('sessions.newSession')));
    fireEvent.mouseLeave(create.parentElement!);
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    assert.deepEqual(onToggleProject.mock.calls, [[project.projectId]]);
  });
}

test('collapsed, loading and foreground-only Running groups have no selection entry', () => {
  const base = props({ isExpanded: false });
  const { rerender } = render(<SidebarProjectItem {...base} />);
  assert.ok(screen.getByRole('button', { name: 'sessions.newSession' }));
  assert.equal(screen.queryByRole('button', { name: 'sessions.selectConversations' }), null);
  rerender(<SidebarProjectItem {...base} isExpanded initialSessionsLoaded={false} />);
  assert.equal(screen.queryByRole('button', { name: 'sessions.selectConversations' }), null);
  rerender(<SidebarProjectItem {...base} isExpanded activeSessions={new Set(['session-1'])} />);
  assert.equal(screen.queryByRole('button', { name: 'sessions.selectConversations' }), null);
  rerender(<SidebarProjectItem {...base} isExpanded activeSessions={new Set(['session-1'])} backgroundSessionIds={new Set(['session-1'])} />);
  assert.ok(screen.getByRole('button', { name: 'sessions.selectConversations' }));
});

test('selection keeps its existing controls and the highlighted header icon also exits it', () => {
  const onCancelSessionSelection = vi.fn();
  render(<SidebarProjectItem {...props({ selectedSessionIds: new Set(), onCancelSessionSelection })} />);
  const exit = screen.getByRole('button', { name: 'sessions.exitSelection' });
  assert.equal(exit.getAttribute('aria-pressed'), 'true');
  assert.ok(screen.getByRole('button', { name: 'sessions.selectAll' }));
  assert.ok(screen.getByRole('button', { name: 'actions.cancel' }));
  assert.ok(screen.getByRole('button', { name: 'sessions.deleteSelected' }));
  fireEvent.click(exit);
  assert.equal(onCancelSessionSelection.mock.calls.length, 1);
});
