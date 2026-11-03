import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { OpenCodeAvailability } from '@/modules/settings/tabs/agents-settings/sections/content/OpenCodeAvailability';
import '@/modules/i18n';

const mocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providers: { authStatus: mocks.status } } }));
const response = (modelCount: number | null, error?: string) => new Response(JSON.stringify({
  success: true, data: { authenticated: false, projectAvailability: { directory: '/fixture', modelCount, error } },
}));
beforeEach(() => mocks.status.mockReset());

test('native availability stays separate from login state and ignores responses for a previous project', async () => {
  let finishHome!: (value: Response) => void;
  mocks.status.mockImplementationOnce(() => new Promise((resolve) => { finishHome = resolve; }))
    .mockResolvedValueOnce(response(2));
  render(<OpenCodeAvailability projects={[{ name: 'project', fullPath: '/project' }]} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '/project' } });
  expect(await screen.findByText('2 models available')).toBeTruthy();
  expect(mocks.status).toHaveBeenLastCalledWith('opencode', '/project');
  await act(async () => finishHome(response(0)));
  expect(screen.getByText('2 models available')).toBeTruthy();
});

test('failed checks show an error and retry can return a legitimate empty catalog', async () => {
  mocks.status.mockResolvedValueOnce(response(null, 'Native host unavailable')).mockResolvedValueOnce(response(0));
  render(<OpenCodeAvailability projects={[]} />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Native host unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(await screen.findByText('No models available in this project.')).toBeTruthy();
});
