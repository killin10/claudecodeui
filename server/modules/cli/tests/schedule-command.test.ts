import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSessionCommand, sessionHelp } from '../session-command.js';

const parse = (args: string[]) => parseSessionCommand(args, 'schedule');
test('schedule parser requires named IDs, rejects irrelevant flags, and separates cron from run-at', () => {
  assert.throws(() => parse(['show', 'task-id']), /positional/);
  assert.throws(() => parse(['show', '--schedule-id', 'a', '--cron', '* * * * *']), /not valid/);
  assert.throws(
    () =>
      parse([
        'preview',
        '--cron',
        '* * * * *',
        '--run-at',
        '2030-01-01T00:00:00Z',
        '--timezone',
        'UTC',
      ]),
    /exactly one/,
  );
  assert.throws(
    () =>
      parse([
        'create',
        '--session-id',
        's',
        '--name',
        'n',
        '--timezone',
        'UTC',
        '--cron',
        '* * * * *',
      ]),
    /message/,
  );
  assert.throws(() => parse(['update', '--schedule-id', 's']), /revision/);
  assert.throws(
    () =>
      parse(['update', '--schedule-id', 's', '--revision', '1', '--model', 'a', '--inherit-model']),
    /mutually exclusive/,
  );
  const input = parse([
    'create',
    '--session-id',
    's',
    '--name',
    'n',
    '--timezone',
    'UTC',
    '--cron',
    '* * * * *',
    '--stdin',
  ]);
  assert.equal(input.options.stdin, true);
  assert.match(sessionHelp('', 'schedule'), /five numeric fields/);
  assert.match(sessionHelp('', 'schedule'), /not model completion/);
});
