import React from 'react';
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useNavigate } from 'react-router-dom';

import App from '@/App';
import { api } from '@/shared/api';

const state = vi.hoisted(() => ({ setSidebarOpen: vi.fn() }));
function Pass({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
vi.mock('@/shared/context/ThemeContext', () => ({ ThemeProvider: Pass }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ UiPreferencesProvider: Pass }));
vi.mock('@/modules/auth', () => ({ AuthProvider: Pass, ProtectedRoute: Pass }));
vi.mock('@/modules/plugins', () => ({ PluginsProvider: Pass }));
vi.mock('@/modules/task-master', () => ({ TaskMasterProvider: Pass, TasksSettingsProvider: Pass }));
vi.mock('@/shared/context/WebSocketContext', () => ({
  WebSocketProvider: Pass,
  useWebSocket: () => ({}),
  useOptionalWebSocket: () => null,
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  SessionProtectionProvider: Pass,
  useSessionProtectionActions: () => ({}),
}));
vi.mock('@/modules/command-palette', () => ({
  PaletteOpsProvider: Pass,
  usePaletteOpsRegister: () => {},
}));
vi.mock('@/shared/hooks/useDeviceSettings', () => ({
  useDeviceSettings: () => ({ isMobile: true }),
}));
vi.mock('@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset', () => ({
  useVisualViewportKeyboardOffset: () => {},
}));
vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  ProjectsStateProvider: Pass,
  useProjectMainState: () => state,
  useProjectEffectsState: () => state,
}));
vi.mock('@/modules/project-workspace/ProjectCommandPalette', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/ProjectQuickSettingsRegion', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/WorkspaceMain', () => ({
  default: () => <div>Chat content</div>,
}));
vi.mock('@/modules/project-workspace/ProjectSidebarRegion', () => ({
  default: function Sidebar() {
    const navigate = useNavigate();
    return (
      <aside aria-label="Persistent sidebar">
        <input aria-label="Sidebar search" />
        <button onClick={() => navigate('/schedules')}>Schedules nav</button>
        <button onClick={() => navigate('/session/target')}>Session nav</button>
      </aside>
    );
  },
}));

beforeEach(() => {
  window.history.replaceState({}, '', '/session/target');
  vi.spyOn(api.schedules, 'list').mockImplementation(
    async () => new Response(JSON.stringify({ items: [], nextToken: null })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  state.setSidebarOpen.mockReset();
});

test('App schedules route preserves the workspace sidebar while replacing only chat content', async () => {
  render(<App />);
  const sidebar = screen.getByRole('complementary', { name: 'Persistent sidebar' });
  const search = screen.getByLabelText('Sidebar search');
  fireEvent.change(search, { target: { value: 'keep this search' } });
  expect(screen.getByText('Chat content')).toBeTruthy();
  fireEvent.click(screen.getByText('Schedules nav'));
  await screen.findByRole('main');
  expect(screen.queryByText('Chat content')).toBeNull();
  expect(screen.getByRole('complementary')).toBe(sidebar);
  expect((search as HTMLInputElement).value).toBe('keep this search');
  expect(state.setSidebarOpen).toHaveBeenLastCalledWith(false);
  const menu = document.querySelector('.pwa-menu-button') as HTMLButtonElement;
  fireEvent.click(menu);
  expect(state.setSidebarOpen).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByText('Session nav'));
  expect(screen.getByText('Chat content')).toBeTruthy();
  expect(screen.getByRole('complementary')).toBe(sidebar);
});

test.each(['/schedules', '/schedules/'])('direct navigation to %s still renders the sidebar and main panel', async (path) => {
  window.history.replaceState({}, '', path);
  render(<App />);
  expect(screen.getByRole('complementary')).toBeTruthy();
  await screen.findByRole('main');
  expect(screen.queryByText('Chat content')).toBeNull();
});
