import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent, RefObject } from 'react';
import { test, vi } from 'vitest';

import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';
import type { Project } from '@/shared/types';

const command = { name: '/btw', type: 'built-in', metadata: { inputOnly: true } };
const commands = [command];
vi.mock('@/shared/hooks/useProjectSlashCommands', () => ({
  useProjectSlashCommands: () => ({ commands, isLoading: false, error: false }),
}));

for (const action of ['Tab', 'Enter', 'click']) {
  test(`/btw ${action} completes input without executing a backend command`, async () => {
    const textarea = document.createElement('textarea');
    textarea.value = '/bt';
    textarea.setSelectionRange(3, 3);
    const project = { projectId: 'p', fullPath: '/tmp/project' } as Project;
    const setInput = vi.fn();
    const execute = vi.fn();
    const { result } = renderHook(() => useSlashCommands({
      selectedProject: project,
      provider: 'codex', input: '/bt', setInput,
      textareaRef: { current: textarea } as RefObject<HTMLTextAreaElement>,
      onExecuteCommand: execute,
    }));
    act(() => result.current.handleCommandInputChange('/bt', 3));
    await waitFor(() => assert.equal(result.current.filteredCommands[0]?.name, '/btw'));
    act(() => {
      if (action === 'click') result.current.handleCommandSelect(command, 0, false);
      else result.current.handleCommandMenuKeyDown({ key: action, preventDefault() {} } as KeyboardEvent<HTMLTextAreaElement>);
    });
    assert.equal(setInput.mock.calls.at(-1)?.[0], '/btw ');
    assert.equal(execute.mock.calls.length, 0);
  });
}
