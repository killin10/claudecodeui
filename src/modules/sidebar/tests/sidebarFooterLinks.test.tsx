import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { TFunction } from 'i18next';

import SidebarFooter from '@/modules/sidebar/SidebarFooter';
import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';

const t = ((key: string) => key) as TFunction;
test('expanded and collapsed sidebar omit issue/community links while retaining settings and schedules', () => {
  const actions = {
    onShowSettings: vi.fn(),
    onShowVersionModal: vi.fn(),
    updateAvailable: false,
    restartRequired: false,
    t,
  };
  render(
    <SidebarFooter {...actions} currentVersion="1.37.7" releaseInfo={null} latestVersion={null} />,
  );
  expect(screen.queryByText('actions.reportIssue')).toBeNull();
  expect(screen.queryByText('actions.joinCommunity')).toBeNull();
  expect(screen.getAllByText('actions.settings')).toHaveLength(2);
  expect(screen.getByRole('link', { name: 'common:schedules.title' })).toBeTruthy();
  cleanup();
  render(<SidebarCollapsed {...actions} onExpand={vi.fn()} />);
  expect(screen.queryByRole('link', { name: 'actions.reportIssue' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'actions.joinCommunity' })).toBeNull();
  expect(screen.getByRole('button', { name: 'actions.settings' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'common:schedules.title' })).toBeTruthy();
});
