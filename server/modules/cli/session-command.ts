import { parseArgs } from 'node:util';

import type { SessionCliOptions } from '@/shared/types.js';

const GLOBAL = ['output', 'query', 'endpoint', 'config-file', 'debug', 'only-show-errors', 'help'];

const MESSAGE = ['message', 'message-file', 'stdin'];

const COMMANDS: Record<string, {
  options: string[];
  required?: string[];
  description: string;
}> = {
  list: { options: ['provider', 'project-path', 'search', 'archive-state', 'execution-state', 'max-items', 'starting-token'], description: 'List sessions (automatically follows pagination unless max-items is set).' },
  show: { options: ['session-id'], required: ['session-id'], description: 'Show one CloudCLI session.' },
  create: { options: ['provider', 'project-path', 'model', 'title', 'permission-mode', 'client-token'], required: ['provider', 'project-path'], description: 'Create an empty session without starting a model.' },
  send: { options: ['session-id', ...MESSAGE, 'if-busy', 'client-token'], required: ['session-id'], description: 'Accept a durable message submission; return without waiting for execution.' },
  archive: { options: ['session-id'], required: ['session-id'], description: 'Archive an idle session without deleting its native data.' },
  restore: { options: ['session-id'], required: ['session-id'], description: 'Restore an archived session.' },
  delete: { options: ['session-id', 'permanent'], required: ['session-id', 'permanent'], description: 'Permanently delete the app session and native provider data.' },
  'message list': { options: ['session-id', 'max-items', 'starting-token'], required: ['session-id'], description: 'Read session history.' },
  'submission show': { options: ['session-id', 'submission-id'], required: ['session-id', 'submission-id'], description: 'Read a submission state and result, including a failed result.' },
  'submission wait': { options: ['session-id', 'submission-id', 'timeout-seconds'], required: ['session-id', 'submission-id'], description: 'Wait for a submission; exit nonzero unless it succeeds.' },
  'submission cancel': { options: ['session-id', 'submission-id'], required: ['session-id', 'submission-id'], description: 'Cancel this queued submission or stop its own active run.' },
};

const BOOLEAN = new Set(['debug', 'only-show-errors', 'help', 'stdin', 'permanent']);

/** CLI-local errors retain a stable machine code and a documented exit status. */
export class SessionCliError extends Error {
  constructor(public code: string, message: string, public exitCode = 2) { super(message); }
}

/** Strict parser for the session command tree: business values are always named options. */
export function parseSessionCommand(args: string[]) {
  const names = new Set([...GLOBAL, ...Object.values(COMMANDS).flatMap((definition) => definition.options)]);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, tokens: true,
      options: Object.fromEntries([...names].map((name) => [name, { type: BOOLEAN.has(name) ? 'boolean' : 'string' }])) });
  }
  catch (error) {
    throw new SessionCliError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));
  }
  const command = parsed.positionals.join(' ');
  const definition = COMMANDS[command];
  const options = parsed.values as SessionCliOptions;
  if (!definition && !(options.help && !command)) {
    throw new SessionCliError('INVALID_COMMAND', `Unknown command or positional argument: ${command}. Use cloudcli session --help.`);
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== 'option') {
      continue;
    }
    if (seen.has(token.name)) {
      throw new SessionCliError('INVALID_ARGUMENT', `Repeated option: --${token.name}`);
    }
    seen.add(token.name);
    if (!GLOBAL.includes(token.name) && !definition?.options.includes(token.name)) {
      throw new SessionCliError('INVALID_ARGUMENT', `--${token.name} is not valid for ${command}.`);
    }
  }
  if (!options.help) {
    for (const key of definition?.required ?? []) {
      if (!options[key]) {
        throw new SessionCliError('INVALID_ARGUMENT', `--${key} is required.`);
      }
    }
    for (const [name, value] of Object.entries(options)) {
      if (typeof value === 'string' && !value.trim()) {
        throw new SessionCliError('INVALID_ARGUMENT', `--${name} must not be empty.`);
      }
    }
    if (command === 'send' && MESSAGE.filter((key) => options[key] !== undefined).length !== 1) {
      throw new SessionCliError('INVALID_ARGUMENT', 'Specify exactly one of --message, --message-file or --stdin.');
    }
  }
  if (options.output && !['json', 'table', 'tsv'].includes(String(options.output))) {
    throw new SessionCliError('INVALID_ARGUMENT', '--output must be json, table or tsv.');
  }
  return { command, options };
}

/** Help shared by the CLI entrypoint and command contract tests. */
export function sessionHelp(command: string): string {
  const commands = command ? [[command, COMMANDS[command]] as const] : Object.entries(COMMANDS);
  return ['Usage: cloudcli session <command> [named options]', '', ...commands.flatMap(([name, definition]) => [
      `${name}: ${definition.description}`, `  ${definition.options.map((option) => `--${option}${BOOLEAN.has(option) ? '' : ' <value>'}`).join(' ')}`,
      `  Required: ${(definition.required ?? []).map((key) => '--' + key).join(', ') || 'none'}`,
    ]), '', 'Global: --output json|table|tsv (default json), --query <JMESPath>, --endpoint <URL>, --config-file <path>, --debug, --only-show-errors, --help',
    'Credentials: CLOUDCLI_API_KEY or apiKey in ~/.config/cloudcli/cli.json (mode 0600).',
    'Endpoint: --endpoint > CLOUDCLI_ENDPOINT > config.endpoint > http://127.0.0.1:3001.',
    'Permission modes: default, auto, accept-edits, bypass-permissions, plan (provider-specific).',
    'Pagination: --max-items limits total output; resume using nextToken as --starting-token.',
    'send: --if-busy queue|reject (default queue). --client-token deduplicates create/send requests.',
    'wait: --timeout-seconds defaults to 1800; timeout or Ctrl-C never cancels the server job.',
    'Exit: 0 success; 2 arguments; 3 not found; 4 authentication; 5 conflict; 6 transport/config; 7 execution failed; 8 wait timeout; 130 interrupted.',
    'Use CloudCLI session IDs, not provider-native IDs. Project paths refer to the server; message files are local.',
  ].join('\n');
}
