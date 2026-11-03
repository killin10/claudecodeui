const DEFINITION = [
  'name',
  'message',
  'message-file',
  'stdin',
  'cron',
  'run-at',
  'timezone',
  'misfire-policy',
  'model',
  'permission-mode',
];
const ID = ['schedule-id'];
const PAGE = ['max-items', 'starting-token'];
/** Session CLI's common parser uses these named-only schedule commands. */
export const SCHEDULE_COMMANDS = {
  create: {
    options: [...DEFINITION, 'session-id', 'paused', 'client-token'],
    required: ['name', 'session-id', 'timezone'],
    description: 'Schedule prompts in an existing session; choose --cron or --run-at.',
  },
  list: { options: PAGE, description: 'List your active and paused schedules.' },
  show: { options: ID, required: ID, description: 'Show a schedule and its revision.' },
  update: {
    options: [...ID, ...DEFINITION, 'revision', 'inherit-model', 'inherit-permission-mode'],
    required: [...ID, 'revision'],
    description: 'Edit future occurrences; revision is required to prevent lost edits.',
  },
  pause: {
    options: ID,
    required: ID,
    description: 'Stop future triggers; existing submissions continue.',
  },
  resume: { options: ID, required: ID, description: 'Resume from the next future occurrence.' },
  delete: {
    options: ID,
    required: ID,
    description: 'Remove a schedule; execution history and existing submissions remain.',
  },
  run: {
    options: [...ID, 'client-token'],
    required: ID,
    description: 'Trigger now without changing the next scheduled time.',
  },
  preview: {
    options: ['cron', 'run-at', 'timezone'],
    required: ['timezone'],
    description: 'Preview the next five occurrences.',
  },
  'run list': {
    options: [...ID, ...PAGE],
    required: ID,
    description: 'List execution records, including skipped triggers.',
  },
  'run show': {
    options: [...ID, 'run-id'],
    required: [...ID, 'run-id'],
    description: 'Read an execution and its actual submission result.',
  },
  'run cancel': {
    options: [...ID, 'run-id'],
    required: [...ID, 'run-id'],
    description: 'Cancel only this execution; future triggers remain enabled.',
  },
};
