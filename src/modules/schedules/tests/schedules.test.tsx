import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => undefined;
  vi.spyOn(api.schedules, 'preview').mockImplementation(async () =>
    json({
      times: [
        '2030-01-01T01:00:00Z',
        '2030-01-02T01:00:00Z',
        '2030-01-03T01:00:00Z',
        '2030-01-04T01:00:00Z',
        '2030-01-07T01:00:00Z',
      ],
    }),
  );
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('create binds an existing session, previews timezone, and sends named configuration with an idempotency token', async () => {
  const create = vi.spyOn(api.schedules, 'create').mockResolvedValue(json(task));
  vi.spyOn(api.schedules, 'preview').mockResolvedValue(json({ times: ['2030-01-01T01:00:00Z'] }));
  const saved = vi.fn();
  render(
    <ScheduleForm task={null} initialSessionId="session" onSaved={saved} onClose={() => {}} />,
  );
  await screen.findByText('Target');
  fireEvent.change(screen.getByLabelText('schedules.name'), { target: { value: 'My task' } });
  fireEvent.change(screen.getByLabelText('schedules.message'), {
    target: { value: 'Review this project' },
  });
  fireEvent.change(screen.getByLabelText('schedules.timezone'), {
    target: { value: 'Asia/Shanghai' },
  });
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
  await waitFor(() => expect(api.schedules.preview).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '* * * * *' } });
  await act(async () => resolve(json({ times: ['2030-01-01T01:00:00Z'] })));
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
  await screen.findByText('Target');
  fireEvent.click(screen.getByRole('combobox', { name: 'schedules.session' }));
  await screen.findByText('Catalog unavailable');
  expect(screen.getByRole('combobox', { name: 'schedules.session' }).textContent).toContain(
    'Target',
  );
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
  fireEvent.click(screen.getByRole('combobox', { name: 'schedules.session' }));
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

test('HTTP browsers without randomUUID can open and create a task, retaining the token on retry', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const create = vi
    .spyOn(api.schedules, 'create')
    .mockRejectedValueOnce(new Error('Response lost'))
    .mockResolvedValue(json(task));
  try {
    render(
      <MemoryRouter>
        <SchedulesPage />
      </MemoryRouter>,
    );
    await screen.findByText('Daily review');
    fireEvent.click(screen.getByText('schedules.create'));
    const form = screen.getByRole('form');
    fireEvent.click(screen.getByRole('combobox', { name: 'schedules.session' }));
    fireEvent.click(await screen.findByRole('option', { name: /Target/ }));
    fireEvent.change(screen.getByLabelText('schedules.name'), { target: { value: 'HTTP task' } });
    fireEvent.change(screen.getByLabelText('schedules.message'), { target: { value: 'Inspect' } });
    fireEvent.submit(form);
    await screen.findByText('Response lost');
    fireEvent.submit(form);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const first = create.mock.calls[0][0] as { clientToken: string };
    const second = create.mock.calls[1][0] as { clientToken: string };
    expect(first.clientToken).toMatch(/^[\w.:-]{1,128}$/);
    expect(second.clientToken).toBe(first.clientToken);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('HTTP browsers without randomUUID can manually trigger a task', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const action = vi.spyOn(api.schedules, 'action').mockResolvedValue(json({}));
  vi.spyOn(api.schedules, 'runs').mockResolvedValue(json({ items: [], nextToken: null }));
  try {
    render(
      <MemoryRouter>
        <SchedulesPage />
      </MemoryRouter>,
    );
    await screen.findByText('Daily review');
    fireEvent.click(screen.getByText('schedules.runNow'));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith('task', 'run', {
        clientToken: expect.stringMatching(/^[\w.:-]{1,128}$/),
      }),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

test('timing preview updates automatically, shows five dates below Cron, and survives unrelated edits', async () => {
  render(<ScheduleForm task={task} initialSessionId="" onSaved={() => {}} onClose={() => {}} />);
  const preview = screen.getByRole('region', { name: 'schedules.preview' });
  await waitFor(() => expect(within(preview).getAllByRole('listitem')).toHaveLength(5));
  expect(screen.queryByRole('button', { name: 'schedules.preview' })).toBeNull();
  expect(
    screen.getByLabelText('Cron').compareDocumentPosition(preview) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText('schedules.message'), {
    target: { value: 'New message' },
  });
  expect(within(preview).getAllByRole('listitem')).toHaveLength(5);
  expect(api.schedules.preview).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '0 10 * * *' } });
  fireEvent.change(screen.getByLabelText('schedules.timezone'), { target: { value: 'UTC' } });
  await waitFor(() =>
    expect(api.schedules.preview).toHaveBeenLastCalledWith({
      cron: '0 10 * * *',
      runAt: null,
      timezone: 'UTC',
    }),
  );
  expect(api.schedules.preview).toHaveBeenCalledTimes(2);
});

test('invalid timing shows an inline error and recovers when the draft is corrected', async () => {
  vi.mocked(api.schedules.preview).mockRejectedValueOnce(new Error('Invalid cron'));
  render(<ScheduleForm task={task} initialSessionId="" onSaved={() => {}} onClose={() => {}} />);
  await screen.findByText('Invalid cron');
  fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '0 10 * * *' } });
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
  expect(screen.queryByText('Invalid cron')).toBeNull();
});

test('session dropdown selects with the keyboard, closes on Escape, and retains the selection', async () => {
  render(<ScheduleSessionPicker initialId="" disabled={false} />);
  const trigger = screen.getByRole('combobox', { name: 'schedules.session' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  await screen.findByRole('option', { name: /Target/ });
  fireEvent.keyDown(screen.getByLabelText('schedules.searchSessions'), { key: 'Enter' });
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
  expect(trigger.textContent).toContain('Target');
  expect((document.querySelector('input[name="sessionId"]') as HTMLInputElement).value).toBe(
    'session',
  );
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByLabelText('schedules.searchSessions'), { key: 'Escape' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
});

test('deleting uses the themed confirmation dialog and preserves the task when cancelled', async () => {
  const remove = vi.spyOn(api.schedules, 'remove').mockResolvedValue(json({}));
  render(
    <MemoryRouter>
      <SchedulesPage />
    </MemoryRouter>,
  );
  await screen.findByText('Daily review');
  fireEvent.click(screen.getByRole('button', { name: 'schedules.delete' }));
  let dialog = screen.getByRole('dialog');
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'buttons.cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'schedules.delete' }));
  dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'schedules.delete' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('task'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('creating without selecting a session reports validation instead of sending an empty target', async () => {
  const create = vi.spyOn(api.schedules, 'create');
  render(<ScheduleForm task={null} initialSessionId="" onSaved={() => {}} onClose={() => {}} />);
  fireEvent.submit(screen.getByRole('form'));
  expect(screen.getByRole('alert').textContent).toBe('schedules.chooseSession');
  expect(create).not.toHaveBeenCalled();
});

test.each(['success', 'failure'])('a late initial session lookup (%s) cannot replace a newer selection', async (outcome) => {
  let resolveInitial!: (response: Response) => void;
  let rejectInitial!: (error: Error) => void;
  vi.mocked(api.schedules.session).mockImplementation(() => new Promise((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  }));
  const other = { sessionId: 'other', title: 'Other target', provider: 'codex', projectPath: '/other' };
  vi.mocked(api.schedules.sessions).mockImplementation(async () => json({ items: [other], nextToken: null }));
  const { container } = render(<ScheduleSessionPicker initialId="session" disabled={false} />);
  fireEvent.click(screen.getByRole('combobox', { name: 'schedules.session' }));
  fireEvent.click(await screen.findByRole('option', { name: /Other target/ }));
  await act(async () => {
    if (outcome === 'success') {
      resolveInitial(json({ sessionId: 'session', title: 'Original target', provider: 'codex' }));
    } else {
      rejectInitial(new Error('Old lookup failed'));
    }
  });
  expect(screen.getByRole('combobox', { name: 'schedules.session' }).textContent).toContain('Other target');
  expect((container.querySelector('input[name="sessionId"]') as HTMLInputElement).value).toBe('other');
  expect(screen.queryByText('Old lookup failed')).toBeNull();
});

test('search Enter chooses a matching session and an empty search result preserves the current target', async () => {
  const other = { sessionId: 'other', title: 'Other target', provider: 'codex' };
  vi.mocked(api.schedules.sessions).mockImplementation(async (search) => json({
    items: search === 'missing' ? [] : [other], nextToken: null,
  }));
  const { container } = render(<ScheduleSessionPicker initialId="session" disabled={false} />);
  await screen.findByText('Target');
  fireEvent.click(screen.getByRole('combobox', { name: 'schedules.session' }));
  fireEvent.change(screen.getByLabelText('schedules.searchSessions'), { target: { value: 'Other' } });
  await screen.findByRole('option', { name: /Other target/ });
  fireEvent.keyDown(screen.getByLabelText('schedules.searchSessions'), { key: 'Enter', code: 'Enter' });
  expect(screen.getByRole('combobox', { name: 'schedules.session' }).textContent).toContain('Other target');
  fireEvent.click(screen.getByRole('combobox', { name: 'schedules.session' }));
  fireEvent.change(screen.getByLabelText('schedules.searchSessions'), { target: { value: 'missing' } });
  await screen.findByText('schedules.noSessions');
  expect(screen.queryAllByRole('option')).toHaveLength(0);
  fireEvent.keyDown(screen.getByLabelText('schedules.searchSessions'), { key: 'Enter', code: 'Enter' });
  expect((container.querySelector('input[name="sessionId"]') as HTMLInputElement).value).toBe('other');
});

test('schedule timestamps use 24-hour time in the rule timezone, including midnight', async () => {
  const { ScheduleTime } = await import('@/modules/schedules/ScheduleTime');
  const { rerender } = render(<ScheduleTime value="2030-01-01T05:07:00Z" timezone="Asia/Shanghai" />);
  expect(screen.getByText(/13:07/)).toBeTruthy();
  expect(screen.queryByText(/AM|PM/)).toBeNull();
  rerender(<ScheduleTime value="2030-01-01T16:00:00Z" timezone="Asia/Shanghai" />);
  expect(screen.getByText(/00:00/)).toBeTruthy();
  expect(screen.queryByText(/24:00|AM|PM/)).toBeNull();
});

test('execution output expands beneath its row, switches safely and collapses without late responses reopening it', async () => {
  const runs: ScheduleRun[] = ['first', 'second'].map((id) => ({
    runId: id, scheduleId: 'task', sessionId: 'session', scheduledFor: '2030-01-01T00:00:00Z',
    source: 'scheduled', state: 'succeeded', reason: null, submissionId: id,
    createdAt: '2030-01-01T00:00:00Z', snapshot: task,
  }));
  vi.spyOn(api.schedules, 'runs').mockImplementation(async () => json({ items: runs, nextToken: null }));
  let resolveFirst!: (response: Response) => void;
  const request = vi.spyOn(api.schedules, 'run').mockImplementation(async (_scheduleId, runId) => {
    if (runId === 'first') return new Promise((resolve) => { resolveFirst = resolve; });
    return json({ submission: { result: [{ content: 'Second output' }], error: null }, reason: null });
  });
  render(<MemoryRouter><ScheduleHistory scheduleId="task" /></MemoryRouter>);
  const buttons = await screen.findAllByRole('button', { name: 'schedules.result' });
  const firstRow = buttons[0].parentElement!.parentElement!;
  const secondRow = buttons[1].parentElement!.parentElement!;
  fireEvent.click(buttons[0]);
  expect(within(firstRow).getByRole('status')).toBeTruthy();
  fireEvent.click(buttons[1]);
  await within(secondRow).findByText('Second output');
  await act(async () => resolveFirst(json({ submission: { result: [{ content: 'Old first output' }], error: null } })));
  expect(screen.queryByText('Old first output')).toBeNull();
  expect(within(firstRow).queryByText('Second output')).toBeNull();
  fireEvent.click(within(secondRow).getByRole('button', { name: 'schedules.collapseResult' }));
  expect(screen.queryByText('Second output')).toBeNull();
  request.mockRejectedValueOnce(new Error('Result unavailable'));
  fireEvent.click(within(secondRow).getByRole('button', { name: 'schedules.result' }));
  await within(secondRow).findByText('Result unavailable');
  expect(within(firstRow).queryByRole('alert')).toBeNull();
});

test('edit opens the selected task in a dialog and cancelling preserves the list position', async () => {
  const update = vi.spyOn(api.schedules, 'update');
  render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
  await screen.findByText('Daily review');
  const list = screen.getByText('schedules.intro').parentElement!.parentElement!;
  list.scrollTop = 800;
  fireEvent.click(screen.getByRole('button', { name: 'schedules.edit' }));
  const dialog = screen.getByRole('dialog', { name: 'schedules.edit' });
  expect(within(dialog).getByLabelText('schedules.name')).toHaveProperty('value', task.name);
  expect(list.contains(within(dialog).getByRole('form'))).toBe(false);
  fireEvent.change(within(dialog).getByLabelText('schedules.message'), { target: { value: 'Unsaved draft' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'schedules.close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(list.scrollTop).toBe(800);
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'schedules.edit' }));
  expect(screen.getByLabelText('schedules.message')).toHaveProperty('value', task.message);
});

test('session picker Escape closes the dropdown before the creation dialog', async () => {
  render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'schedules.create' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'schedules.session' }));
  await screen.findByRole('option', { name: /Target/ });
  fireEvent.keyDown(screen.getByLabelText('schedules.searchSessions'), { key: 'Escape' });
  expect(screen.getByRole('dialog', { name: 'schedules.create' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: /Target/ })).toBeNull();
  fireEvent.keyDown(screen.getByLabelText('schedules.name'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('save keeps the dialog open while pending, retains failed drafts, and closes after success', async () => {
  let rejectSave!: (reason: Error) => void;
  const update = vi.spyOn(api.schedules, 'update').mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
  render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
  await screen.findByText('Daily review');
  fireEvent.click(screen.getByRole('button', { name: 'schedules.edit' }));
  fireEvent.change(screen.getByLabelText('schedules.message'), { target: { value: 'Updated prompt' } });
  fireEvent.submit(screen.getByRole('form'));
  fireEvent.keyDown(screen.getByLabelText('schedules.name'), { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  await act(async () => rejectSave(new Error('Save failed')));
  expect(screen.getByRole('alert').textContent).toBe('Save failed');
  expect(screen.getByLabelText('schedules.message')).toHaveProperty('value', 'Updated prompt');
  update.mockResolvedValueOnce(json(task));
  fireEvent.submit(screen.getByRole('form'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(update).toHaveBeenLastCalledWith('task', expect.objectContaining({ message: 'Updated prompt', revision: 2 }));
});

test('session navigation opens the creation dialog with its session preselected', async () => {
  render(<MemoryRouter initialEntries={['/schedules?sessionId=session']}><SchedulesPage /></MemoryRouter>);
  const dialog = screen.getByRole('dialog', { name: 'schedules.create' });
  await within(dialog).findByText('Target');
  expect(within(dialog).getByRole('combobox', { name: 'schedules.session' }).textContent).toContain('Target');
});
