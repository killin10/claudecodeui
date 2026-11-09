import assert from 'node:assert/strict';

import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import SubscriptionUsagePanel from '@/modules/chat/modals/SubscriptionUsagePanel';
import type { SubscriptionUsageReport } from '@/shared/types';

const subscriptionUsage = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { providers: { subscriptionUsage: (refresh?: boolean) => subscriptionUsage(refresh) } },
  readApiJson: async (response: Response) => response.json(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}${JSON.stringify(options)}` : key,
  }),
}));

const NOW = Date.parse('2026-11-09T16:00:00Z');

const report: SubscriptionUsageReport = {
  subscriptions: [
    {
      provider: 'claude',
      status: 'ok',
      plan: 'max',
      observedAt: '2026-11-09T15:59:00Z',
      windows: [
        { key: 'five_hour', period: 'five_hour', scope: null, usedPercent: 92, resetsAt: '2026-11-09T18:30:00Z' },
        { key: 'seven_day', period: 'weekly', scope: 'Opus', usedPercent: 40, resetsAt: '2026-11-12T16:00:00Z' },
      ],
    },
    {
      provider: 'codex',
      status: 'ok',
      plan: 'pro',
      observedAt: '2026-11-08T10:00:00Z',
      // Logged before its reset: the panel must not present 75% as current.
      windows: [{ key: 'primary', period: 'five_hour', scope: null, usedPercent: 75, resetsAt: '2026-11-08T12:00:00Z' }],
    },
    {
      provider: 'zai',
      status: 'unavailable',
      plan: null,
      observedAt: null,
      windows: [],
      message: 'GLM Coding Plan is not connected in OpenCode.',
    },
  ],
};

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('SubscriptionUsagePanel', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    subscriptionUsage.mockReset();
    subscriptionUsage.mockImplementation(async () => jsonResponse({ success: true, data: report }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows each window with its percentage and time to reset, and stale or missing data plainly', async () => {
    const { container, getByText, getAllByRole } = render(<SubscriptionUsagePanel />);
    await waitFor(() => getByText('Z.ai Coding Plan'));

    assert.equal(subscriptionUsage.mock.calls[0][0], false);
    const bars = getAllByRole('progressbar');
    assert.deepEqual(bars.map((bar) => bar.getAttribute('aria-valuenow')), ['92', '40', '75']);
    assert.ok(container.textContent?.includes('chat:subscriptionUsage.period.weekly · Opus'));
    // 2h30m until the 5-hour reset (the duration is nested inside resetsIn, hence the escaped quotes).
    assert.ok(container.textContent?.includes('durationHours{\\"hours\\":2,\\"minutes\\":30}'));
    // 92% is in the danger band; the window that has reset since Codex logged it is greyed out, not amber.
    assert.ok(bars[0].firstElementChild?.className.includes('bg-red-500'));
    assert.ok(!bars[2].firstElementChild?.className.includes('bg-amber-500'));
    getByText('chat:subscriptionUsage.resetPassed');
    getByText('GLM Coding Plan is not connected in OpenCode.');
  });

  it('refresh asks the server to bypass its cache', async () => {
    const { getByText, getByRole } = render(<SubscriptionUsagePanel />);
    await waitFor(() => getByText('Claude'));
    fireEvent.click(getByRole('button', { name: /chat:subscriptionUsage.refresh/ }));
    await waitFor(() => assert.equal(subscriptionUsage.mock.calls.length, 2));
    assert.equal(subscriptionUsage.mock.calls[1][0], true);
  });

  it('reports a failed request instead of loading forever', async () => {
    subscriptionUsage.mockImplementation(async () => {
      throw new Error('offline');
    });
    const { getByText } = render(<SubscriptionUsagePanel />);
    await waitFor(() => getByText('chat:subscriptionUsage.loadFailed'));
  });
});
