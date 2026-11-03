import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import type { Schedule, ScheduleRun } from '@/shared/types';
import { ScheduleForm } from '@/modules/schedules/ScheduleForm';
import { ScheduleHistory } from '@/modules/schedules/ScheduleHistory';
import { ScheduleSessionPicker } from '@/modules/schedules/ScheduleSessionPicker';
import { SchedulesPage } from '@/modules/schedules/SchedulesPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const task: Schedule = {
  scheduleId: 'task',
  sessionId: 'session',
  userId: 1,
  name: 'Daily review',
  message: 'Inspect',
  cron: '0 9 * * 1-5',
  runAt: null,
  timezone: 'Asia/Shanghai',
  misfirePolicy: 'skip',
  model: null,
  permissionMode: null,
  revision: 2,
  enabled: true,
  deleted: false,
  nextRunAt: '2030-01-01T01:00:00Z',
  createdAt: '2029-01-01T00:00:00Z',
  updatedAt: '2029-01-01T00:00:00Z',
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  vi.spyOn(api.schedules, 'list').mockResolvedValue(json({ items: [task], nextToken: null }));
  vi.mocked(api.schedules.list).mockImplementation(async () =>
    json({ items: [task], nextToken: null }),
  );
  vi.spyOn(api.schedules, 'sessions').mockImplementation(async () =>
    json({
      items: [
        { sessionId: 'session', title: 'Target', provider: 'codex', projectPath: '/project' },
      ],
      nextToken: null,
    }),
  );
  vi.spyOn(api.schedules, 'session').mockImplementation(async () =>
    json({ sessionId: 'session', title: 'Target', provider: 'codex', projectPath: '/project' }),
  );
});
afterEach(() => vi.restoreAllMocks());

test('create binds an existing session, previews timezone, and sends named configuration with an idempotency token', async () => {
  const create = vi.spyOn(api.schedules, 'create').mockResolvedValue(json(task));
  vi.spyOn(api.schedules, 'preview').mockResolvedValue(json({ times: ['2030-01-01T01:00:00Z'] }));
  const saved = vi.fn();
  render(
    <ScheduleForm task={null} initialSessionId="session" onSaved={saved} onClose={() => {}} />,
  );
  await screen.findByRole('option', { name: /Target/ });
  fireEvent.change(screen.getByLabelText('schedules.name'), { target: { value: 'My task' } });
  fireEvent.change(screen.getByLabelText('schedules.message'), {
    target: { value: 'Review this project' },
  });
  fireEvent.change(screen.getByLabelText('schedules.timezone'), {
    target: { value: 'Asia/Shanghai' },
  });
  fireEvent.click(screen.getByText('schedules.preview'));
  await screen.findByText(/Monday through Friday/);
  fireEvent.submit(screen.getByRole('form'));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(create.mock.calls[0][0]).toMatchObject({
    name: 'My task',
    sessionId: 'session',
    message: 'Review this project',
    cron: '0 9 * * 1-5',
    runAt: null,
    timezone: 'Asia/Shanghai',
  });
  expect(create.mock.calls[0][0]).toHaveProperty('clientToken');
});

test('editing preserves captured revision and reports stale-write errors without losing draft', async () => {
  const update = vi
    .spyOn(api.schedules, 'update')
    .mockResolvedValue(
      json({ error: { code: 'REVISION_CONFLICT', message: 'Reload changed task' } }, 409),
    );
  render(<ScheduleForm task={task} initialSessionId="" onSaved={() => {}} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('schedules.message'), {
    target: { value: 'Unsaved draft' },
  });
  fireEvent.submit(screen.getByRole('form'));
  await screen.findByText('Reload changed task');
  expect(update.mock.calls[0]).toEqual([
    'task',
    expect.objectContaining({ message: 'Unsaved draft', revision: 2 }),
  ]);
  expect((screen.getByLabelText('schedules.message') as HTMLTextAreaElement).value).toBe(
    'Unsaved draft',
  );
});

test('a preview response for an outdated draft cannot restore stale timing', async () => {
  let resolve!: (response: Response) => void;
  vi.spyOn(api.schedules, 'preview').mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<ScheduleForm task={task} initialSessionId="" onSaved={() => {}} onClose={() => {}} />);
  fireEvent.click(screen.getByText('schedules.preview'));
  fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '* * * * *' } });
  resolve(json({ times: ['2030-01-01T01:00:00Z'] }));
  await waitFor(() => expect(screen.queryByText(/Monday through Friday/)).toBeNull());
});

test('history shows actual waiting/failed states, cancellation, and result details', async () => {
  const run: ScheduleRun = {
    runId: 'r',
    scheduleId: 'task',
    sessionId: 'session',
    scheduledFor: '2030-01-01T00:00:00Z',
    source: 'scheduled',
    state: 'waiting-for-input',
    reason: null,
    submissionId: 'sub',
    createdAt: '2030-01-01T00:00:00Z',
    snapshot: task,
  };
  vi.spyOn(api.schedules, 'runs').mockImplementation(async () =>
    json({ items: [run], nextToken: null }),
  );
  vi.spyOn(api.schedules, 'run').mockResolvedValue(
    json({ submission: { result: [{ content: 'answer' }], error: 'Provider stopped' } }),
  );
  const cancel = vi
    .spyOn(api.schedules, 'cancel')
    .mockResolvedValue(json({ ...run, state: 'cancelled' }));
  render(
    <MemoryRouter>
      <ScheduleHistory scheduleId="task" />
    </MemoryRouter>,
  );
  await screen.findByText('schedules.states.waiting-for-input');
  fireEvent.click(screen.getByText('schedules.result'));
  await screen.findByText(/answer/);
  expect(screen.getByText(/Provider stopped/).textContent).toBe('answer\n\nProvider stopped');
  fireEvent.click(screen.getByText('schedules.cancelRun'));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('task', 'r'));
});

test('page pauses a task without cancelling submissions and shows API errors', async () => {
  const action = vi
    .spyOn(api.schedules, 'action')
    .mockResolvedValue(json({ error: { message: 'Task changed' } }, 409));
  const cancel = vi.spyOn(api.schedules, 'cancel');
  render(
    <MemoryRouter>
      <SchedulesPage />
    </MemoryRouter>,
  );
  await screen.findByText('Daily review');
  fireEvent.click(screen.getByText('schedules.pause'));
  await screen.findByText('Task changed');
  expect(action).toHaveBeenCalledWith('task', 'pause', {});
  expect(cancel).not.toHaveBeenCalled();
});

test('session search failure is visible and selected sessions outside page one are retained', async () => {
  vi.mocked(api.schedules.sessions).mockRejectedValue(new Error('Catalog unavailable'));
  render(<ScheduleSessionPicker initialId="session" disabled={false} />);
  await screen.findByRole('option', { name: /Target/ });
  await screen.findByText('Catalog unavailable');
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('session');
});

test('session pagination prevents duplicate requests and ignores errors from an outdated search', async () => {
  let rejectPage!: (error: Error) => void;
  vi.mocked(api.schedules.sessions).mockImplementation(async (search, token) => {
    if (token)
      return new Promise<Response>((_, reject) => {
        rejectPage = reject;
      });
    return json({
      items: [{ sessionId: search || 'first', title: search || 'First', provider: 'codex' }],
      nextToken: search ? null : 'next',
    });
  });
  render(<ScheduleSessionPicker initialId="" disabled={false} />);
  const more = await screen.findByText('schedules.loadMore');
  fireEvent.click(more);
  fireEvent.click(more);
  expect(api.schedules.sessions).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText('schedules.searchSessions'), {
    target: { value: 'New search' },
  });
  await screen.findByRole('option', { name: /New search/ });
  await act(async () => rejectPage(new Error('Old page failed')));
  expect(screen.queryByText('Old page failed')).toBeNull();
});
