import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSessionCommand, sessionHelp } from '../session-command.js';

test('session IDs are named and options are order independent', () => {
  const parsed = parseSessionCommand(['--output', 'json', 'show', '--session-id=abc']);
  assert.equal(parsed.command, 'show');
  assert.equal(parsed.options['session-id'], 'abc');
  assert.throws(() => parseSessionCommand(['show', 'abc']), /positional/);
});

test('unknown, irrelevant and repeated arguments fail before making requests', () => {
  for (const args of [['show', '--session-id', 'a', '--oops'], ['show', '--session-id', 'a', '--model', 'b'], ['show', '--session-id', 'a', '--session-id', 'b']]) {
    assert.throws(() => parseSessionCommand(args));
  }
});

test('mutations require explicit IDs and permanent intent; message sources are exclusive', () => {
  assert.throws(() => parseSessionCommand(['delete', '--session-id', 'a']), /permanent/);
  assert.throws(() => parseSessionCommand(['archive']), /session-id/);
  assert.throws(() => parseSessionCommand(['send', '--session-id', 'a']), /exactly one/);
  assert.throws(() => parseSessionCommand(['send', '--session-id', 'a', '--stdin', '--message', 'text']), /exactly one/);
  assert.equal(parseSessionCommand(['send', '--session-id', 'a', '--message', '$(literal)']).options.message, '$(literal)');
});

test('help documents return codes, credentials and timeout behavior', () => {
  assert.equal(parseSessionCommand(['--help']).options.help, true);
  const help = sessionHelp('submission wait');
  assert.match(help, /timeout/);
  assert.match(help, /never cancels/);
  assert.match(help, /CLOUDCLI_API_KEY/);
});
