import { fireEvent, render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';

test('normalized shell uses the command row with its output inside the same collapse', () => {
  const view = render(<ToolRenderer toolName="Bash" mode="input" toolInput={{ command: 'npm test' }} toolResult={{ content: 'All tests passed' }} />);
  fireEvent.click(view.getByText('npm test'));
  expect(view.getByText('All tests passed')).toBeTruthy();
});

test('native checklist includes cancelled tasks without showing them as pending', () => {
  const view = render(<ToolRenderer toolName="TodoWrite" mode="input" toolInput={{ todos: [
    { content: 'Test changes', status: 'in_progress' }, { content: 'Obsolete step', status: 'cancelled' },
  ] }} toolResult={{ content: 'Updated' }} />);
  expect(view.getByText('Obsolete step').closest('[data-status]')?.getAttribute('data-status')).toBe('cancelled');
});

test('native multi-file patch reuses the diff viewer and opens the selected file', () => {
  const open = vi.fn();
  const view = render(<ToolRenderer toolName="ApplyPatch" mode="input" toolInput={{ patch: 'raw patch' }} onFileOpen={open}
    toolResult={{ content: 'Updated', toolUseResult: { bashEditDiff: { files: [
      { filePath: '/repo/a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] },
      { filePath: '/repo/b.ts', created: true, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+second file'] }] },
    ], moreFiles: 0 } } }} />);
  expect(view.getByText('/repo/a.ts')).toBeTruthy();
  fireEvent.click(view.getByRole('button', { name: 'b.ts' }));
  expect(open).toHaveBeenCalled();
  expect(open.mock.calls[0][0]).toBe('/repo/b.ts');
  expect(view.queryByText('raw patch')).toBeNull();
});

test('an in-flight patch remains inspectable before authoritative diff metadata arrives', () => {
  const view = render(<ToolRenderer toolName="ApplyPatch" mode="input" toolInput={{ patch: '*** Begin Patch\n+new line' }} />);
  fireEvent.click(view.getByText('Patch'));
  expect(view.getByText(/new line/)).toBeTruthy();
});
