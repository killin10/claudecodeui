import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import AgentCategoryContentSection from '@/modules/settings/tabs/agents-settings/sections/AgentCategoryContentSection';
import '@/modules/i18n';

const mocks = vi.hoisted(() => ({ remove: vi.fn(), save: vi.fn() }));
vi.mock('@/modules/skills/hooks/useProviderSkills', () => ({ useProviderSkills: () => ({
  skills: [
    { provider: 'opencode', name: 'owned', command: '/skill:owned', scope: 'user', sourcePath: '/config/opencode/skills/owned/SKILL.md', managedDirectory: 'owned' },
    { provider: 'opencode', name: 'shared', command: '/skill:shared', scope: 'user', sourcePath: '/home/.agents/skills/shared/SKILL.md' },
  ], isLoading: false, isLoadingProjectScopes: false, removeSkill: mocks.remove, addSkills: mocks.save, refreshSkills: vi.fn(),
}) }));

test('OpenCode settings exposes native Skills and only offers deletion for its managed source', async () => {
  mocks.remove.mockResolvedValue(undefined);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<AgentCategoryContentSection selectedAgent="opencode" selectedCategory="skills" projects={[]}
    agentContextById={{} as never} claudePermissions={{} as never} cursorPermissions={{} as never}
    onClaudePermissionsChange={() => {}} onCursorPermissionsChange={() => {}} codexPermissionMode="default" onCodexPermissionModeChange={() => {}} />);
  expect(screen.getByText('/skill:shared')).toBeTruthy();
  const buttons = screen.getAllByRole('button', { name: 'Remove Skill' });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('owned'));
  confirm.mockRestore();
});
