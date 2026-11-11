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

// Keys instead of copy, so assertions do not depend on wording; the rest of the
// module stays real because the websocket context's import graph initialises i18n.
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
// Edit, history and delete live behind each card's overflow menu.
const openMenuItem = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'schedules.more' }));
  fireEvent.click(screen.getByRole('menuitem', { name }));
};
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

test('history shows each run\'s state and failure reason, offers cancellation, and no stored output', async () => {
  const run: ScheduleRun = {
    runId: 'r',
    scheduleId: 'task',
    sessionId: 'session',
    scheduledFor: '2030-01-01T00:00:00Z',
    source: 'scheduled',
    state: 'waiting-for-input',
    reason: 'Provider stopped',
    submissionId: 'sub',
    createdAt: '2030-01-01T00:00:00Z',
    snapshot: task,
  };
  vi.spyOn(api.schedules, 'runs').mockImplementation(async () =>
    json({ items: [run], nextToken: null }),
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
  expect(screen.getByText('Provider stopped')).toBeTruthy();
  // The reply is read in the session, linked from the row; there is no separate result view.
  expect(screen.getByText('schedules.openSession')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'schedules.result' })).toBeNull();
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
  openMenuItem('schedules.delete');
  let dialog = screen.getByRole('dialog');
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'buttons.cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(remove).not.toHaveBeenCalled();
  openMenuItem('schedules.delete');
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

test('edit opens the selected task in a dialog and cancelling preserves the list position', async () => {
  const update = vi.spyOn(api.schedules, 'update');
  render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
  await screen.findByText('Daily review');
  const list = screen.getByText('schedules.intro').parentElement!.parentElement!;
  list.scrollTop = 800;
  openMenuItem('schedules.edit');
  const dialog = screen.getByRole('dialog', { name: 'schedules.edit' });
  expect(within(dialog).getByLabelText('schedules.name')).toHaveProperty('value', task.name);
  expect(list.contains(within(dialog).getByRole('form'))).toBe(false);
  fireEvent.change(within(dialog).getByLabelText('schedules.message'), { target: { value: 'Unsaved draft' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'schedules.close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(list.scrollTop).toBe(800);
  expect(update).not.toHaveBeenCalled();
  openMenuItem('schedules.edit');
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
  openMenuItem('schedules.edit');
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

test('the list is flat with each card naming its session, filters by status and text, and shows fired one-time tasks as completed', async () => {
  const fired: Schedule = {
    ...task, scheduleId: 'once', name: 'Release notes', sessionId: 'other', sessionTitle: 'Other session',
    cron: null, runAt: '2029-06-01T01:00:00Z', enabled: false, nextRunAt: null, lastState: 'succeeded',
  };
  vi.mocked(api.schedules.list).mockImplementation(async () => json({ items: [task, fired], nextToken: null }));
  render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
  await screen.findByText('Daily review');
  // No per-session sections or counts; the enabled task is listed before the completed one.
  expect(screen.queryByRole('region', { name: 'Other session' })).toBeNull();
  const cards = screen.getAllByRole('article');
  expect(within(cards[0]).getByText('Daily review')).toBeTruthy();
  expect(within(cards[0]).getByText('schedules.enabled')).toBeTruthy();
  expect(within(cards[1]).getByText('Other session')).toBeTruthy();
  expect(within(cards[1]).getByText('schedules.completed')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'schedules.filters.completed' }));
  expect(screen.queryByText('Daily review')).toBeNull();
  expect(screen.getByText('Release notes')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'schedules.filters.all' }));
  fireEvent.change(screen.getByLabelText('schedules.filterPlaceholder'), { target: { value: 'daily' } });
  expect(screen.getByText('Daily review')).toBeTruthy();
  expect(screen.queryByText('Release notes')).toBeNull();
  fireEvent.change(screen.getByLabelText('schedules.filterPlaceholder'), { target: { value: 'nothing here' } });
  expect(screen.getByText('schedules.noMatches')).toBeTruthy();
});

test('run now is unavailable while the previous run is still in progress', async () => {
  vi.mocked(api.schedules.list).mockImplementation(async () => json({ items: [{ ...task, lastState: 'running' }], nextToken: null }));
  render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
  await screen.findByText('Daily review');
  const runNow = screen.getByText('schedules.runNow').closest('button') as HTMLButtonElement;
  expect(runNow.disabled).toBe(true);
  expect(runNow.title).toBe('schedules.runNowBusy');
});

test('a one-time task is picked as wall-clock time in the chosen zone and sent as one instant', async () => {
  const create = vi.spyOn(api.schedules, 'create').mockResolvedValue(json(task));
  const saved = vi.fn();
  render(<ScheduleForm task={null} initialSessionId="session" onSaved={saved} onClose={() => {}} />);
  await screen.findByText('Target');
  fireEvent.change(screen.getByLabelText('schedules.name'), { target: { value: 'Once' } });
  fireEvent.change(screen.getByLabelText('schedules.message'), { target: { value: 'Ship it' } });
  fireEvent.click(screen.getByRole('button', { name: 'schedules.once' }));
  fireEvent.change(screen.getByLabelText('schedules.timezone'), { target: { value: 'Asia/Shanghai' } });
  fireEvent.change(screen.getByLabelText('schedules.runAt'), { target: { value: '2031-03-05T09:30' } });
  await waitFor(() => expect(api.schedules.preview).toHaveBeenLastCalledWith({
    cron: null, runAt: '2031-03-05T01:30:00.000Z', timezone: 'Asia/Shanghai',
  }));
  fireEvent.submit(screen.getByRole('form'));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(create.mock.calls[0][0]).toMatchObject({ cron: null, runAt: '2031-03-05T01:30:00.000Z', timezone: 'Asia/Shanghai', misfirePolicy: 'skip' });
});

test('the cron helper only writes the cron field, and reads back rules it can show', async () => {
  render(<ScheduleForm task={null} initialSessionId="" onSaved={() => {}} onClose={() => {}} />);
  const cronField = () => (screen.getByLabelText('Cron') as HTMLInputElement).value;
  const frequency = screen.getByLabelText('schedules.helper.frequency') as HTMLSelectElement;
  expect(frequency.value).toBe('weekdays');
  expect(cronField()).toBe('0 9 * * 1-5');

  fireEvent.change(screen.getByLabelText('schedules.helper.time'), { target: { value: '18:30' } });
  expect(cronField()).toBe('30 18 * * 1-5');
  fireEvent.change(frequency, { target: { value: 'daily' } });
  expect(cronField()).toBe('30 18 * * *');

  fireEvent.change(frequency, { target: { value: 'weekly' } });
  expect(cronField()).toBe('30 18 * * 1');
  fireEvent.click(screen.getByRole('button', { name: 'schedules.helper.weekdayNames.3' }));
  expect(cronField()).toBe('30 18 * * 1,3');

  fireEvent.change(frequency, { target: { value: 'monthly' } });
  fireEvent.change(screen.getByLabelText('schedules.helper.dayOfMonth'), { target: { value: '15' } });
  expect(cronField()).toBe('30 18 15 * *');

  fireEvent.change(frequency, { target: { value: 'hourly' } });
  fireEvent.change(screen.getByLabelText('schedules.helper.minute'), { target: { value: '5' } });
  expect(cronField()).toBe('5 * * * *');

  // A typed rule the helper can show selects it; one it cannot is left as typed.
  fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '0 7 * * 6,0' } });
  expect(frequency.value).toBe('weekly');
  fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '*/15 9-17 * * 1-5' } });
  expect(frequency.value).toBe('');
  expect(cronField()).toBe('*/15 9-17 * * 1-5');
  // Switching back starts from the last rule the helper could show (07:00), not an older one.
  fireEvent.change(frequency, { target: { value: 'daily' } });
  expect(cronField()).toBe('0 7 * * *');
});
