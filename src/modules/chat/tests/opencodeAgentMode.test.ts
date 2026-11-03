import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useOpenCodeAgentMode } from '@/modules/chat/hooks/useOpenCodeAgentMode';
import type { PermissionMode } from '@/shared/types';

const readAgent = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api', () => ({ api: { providers: { opencodeSessionAgent: readAgent } } }));
const response = (agent: string) => ({ ok: true, json: async () => ({ success: true, data: { agent } }) });

function useMode(sessionId: string) {
  const [mode, setMode] = useState<PermissionMode>('default');
  const intent = useOpenCodeAgentMode('opencode', sessionId, setMode);
  return { mode, setMode, ...intent };
}

beforeEach(() => readAgent.mockReset());

test('opening and refreshing a native plan displays plan without requesting a switch', async () => {
  readAgent.mockResolvedValue(response('plan'));
  const first = renderHook(() => useMode('native'));
  await waitFor(() => expect(first.result.current.mode).toBe('plan'));
  expect(first.result.current.permissionModeExplicit).toBe(false);
  first.unmount();
  const refreshed = renderHook(() => useMode('native'));
  await waitFor(() => expect(refreshed.result.current.mode).toBe('plan'));
  expect(refreshed.result.current.permissionModeExplicit).toBe(false);
});

test('late native reads cannot overwrite an explicit selection and intent does not leak across sessions', async () => {
  let resolve!: (value: ReturnType<typeof response>) => void;
  readAgent.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const hook = renderHook(({ id }) => useMode(id), { initialProps: { id: 'one' } });
  act(() => {
    hook.result.current.markExplicit();
    hook.result.current.setMode('acceptEdits');
  });
  await act(async () => resolve(response('plan')));
  expect(hook.result.current.mode).toBe('acceptEdits');
  expect(hook.result.current.permissionModeExplicit).toBe(true);
  readAgent.mockResolvedValue(response('reviewer'));
  hook.rerender({ id: 'two' });
  await waitFor(() => expect(hook.result.current.permissionModeExplicit).toBe(false));
  expect(hook.result.current.mode).toBe('acceptEdits');
});
