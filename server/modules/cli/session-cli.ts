import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import jmespath from 'jmespath';

import type { SessionCliOptions } from '@/shared/types.js';

import { parseSessionCommand, sessionHelp, SessionCliError } from './session-command.js';
import { createSessionClient } from './session-client.js';

type Request = Awaited<ReturnType<typeof createSessionClient>>;

function numberOption(options: SessionCliOptions, name: string, fallback: number): number {
  if (options[name] === undefined) {
    return fallback;
  }
  const text = String(options[name]);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1) {
    throw new SessionCliError('INVALID_ARGUMENT', `--${name} must be a positive integer.`);
  }
  return Number(text);
}

function queryParameters(options: SessionCliOptions): URLSearchParams {
  const query = new URLSearchParams();
  for (const key of ['provider', 'project-path', 'search', 'archive-state', 'execution-state', 'starting-token']) {
    if (options[key] !== undefined) {
      query.set(key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), String(options[key]));
    }
  }
  return query;
}

async function list(request: Request, resource: string, options: SessionCliOptions) {
  const max = numberOption(options, 'max-items', Infinity);
  const query = queryParameters(options);
  const items: unknown[] = [];
  const seen = new Set<string>();
  let nextToken: string | null = null;
  do {
    query.set('maxItems', String(Math.min(100, max - items.length)));
    const page = await request('GET', resource + '?' + query);
    if (!Array.isArray(page.items) || !(page.nextToken === null || typeof page.nextToken === 'string')) {
      throw new SessionCliError('INVALID_RESPONSE', 'Invalid paginated response.', 6);
    }
    items.push(...page.items);
    nextToken = page.nextToken;
    if (nextToken) {
      if (seen.has(nextToken)) {
        throw new SessionCliError('INVALID_RESPONSE', 'Server repeated its pagination token.', 6);
      }
      seen.add(nextToken);
      query.set('startingToken', nextToken);
    }
  } while (nextToken && items.length < max);
  return { items, nextToken };
}

async function message(options: SessionCliOptions): Promise<string> {
  let value: string;
  if (options['message-file']) {
    const file = String(options['message-file']);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 4000000) {
      throw new SessionCliError('INVALID_ARGUMENT', 'Message file must be a regular file smaller than 4 MB.');
    }
    value = await fs.readFile(file, 'utf8');
  } else if (options.stdin) {
    if (process.stdin.isTTY) {
      throw new SessionCliError('INVALID_ARGUMENT', '--stdin requires piped or redirected input.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += Buffer.byteLength(chunk);
      if (size > 4000000) {
        throw new SessionCliError('INVALID_ARGUMENT', 'Message input is too large.');
      }
      chunks.push(Buffer.from(chunk));
    }
    value = Buffer.concat(chunks).toString('utf8');
  } else {
    value = String(options.message);
  }
  if (!value.trim() || value.length > 1000000) {
    throw new SessionCliError('INVALID_ARGUMENT', 'Message must contain 1–1,000,000 characters.');
  }
  return value;
}

async function wait(request: Request, resource: string, options: SessionCliOptions) {
  const deadline = Date.now() + numberOption(options, 'timeout-seconds', 1800) * 1000;
  while (Date.now() < deadline) {
    let result: Record<string, unknown>;
    try {
      result = await request('GET', resource, undefined, Math.max(1, Math.min(30000, deadline - Date.now())));
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new SessionCliError('WAIT_TIMEOUT', 'Wait timed out; the server submission was not cancelled.', 8);
      }
      throw error;
    }
    if (result.state === 'succeeded') {
      return result;
    }
    if (['failed', 'cancelled', 'interrupted'].includes(String(result.state))) {
      throw new SessionCliError('SUBMISSION_FAILED', `${result.state}: ${result.error ?? 'Submission did not succeed.'}`, 7);
    }
    if (!['queued', 'running', 'waiting-for-input'].includes(String(result.state))) {
      throw new SessionCliError('INVALID_RESPONSE', 'Unknown submission state.', 6);
    }
    await delay(Math.max(0, Math.min(1000, deadline - Date.now())));
  }
  throw new SessionCliError('WAIT_TIMEOUT', 'Wait timed out; the server submission was not cancelled.', 8);
}

async function execute(command: string, options: SessionCliOptions) {
  const request = await createSessionClient(options);
  const session = '/sessions/' + encodeURIComponent(String(options['session-id']));
  const submission = session + '/submissions/' + encodeURIComponent(String(options['submission-id']));
  switch (command) {
    case 'list': return list(request, '/sessions', options);
    case 'show': return request('GET', session);
    case 'create': return request('POST', '/sessions', Object.fromEntries(['provider', 'project-path', 'model', 'title', 'permission-mode', 'client-token']
      .filter((key) => options[key] !== undefined).map((key) => [key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), options[key]])));
    case 'send': return request('POST', session + '/messages', { message: await message(options), ifBusy: options['if-busy'] ?? 'queue', clientToken: options['client-token'] });
    case 'archive':
    case 'restore': return request('POST', session + '/' + command, {});
    case 'delete': return request('DELETE', session + '?permanent=true');
    case 'message list': return list(request, session + '/messages', options);
    case 'submission show': return request('GET', submission);
    case 'submission wait': return wait(request, submission, options);
    case 'submission cancel': return request('POST', submission + '/cancel', {});
    default: throw new SessionCliError('INVALID_COMMAND', command);
  }
}

function render(value: unknown, format: string): string {
  if (format === 'json') {
    return JSON.stringify(value, null, 2);
  }
  const data = value as {
    items?: unknown[];
  } | null;
  const rows = Array.isArray(value) ? value : Array.isArray(data?.items) ? data.items : [value];
  const keys = rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]) : [];
  const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/[\t\r\n]/g, ' ');
  const lines = rows.map((row) => keys.length ? keys.map((key) => cell((row as Record<string, unknown>)[key])) : [cell(row)]);
  if (format === 'tsv') {
    return lines.map((line) => line.join('\t')).join('\n');
  }
  if (keys.length) {
    lines.unshift(keys);
  }
  const widths = keys.map((_, i) => Math.min(60, Math.max(...lines.map((line) => line[i].length))));
  return lines.map((line) => line.map((part, i) => part.length > 60 ? part.slice(0, 57) + '...' : part.padEnd(widths[i] ?? part.length)).join('  ')).join('\n');
}

/** CLI entrypoint for session automation. No server imports, database access, or startup side effects. */
export async function runSessionCli(args: string[], family: 'session' | 'schedule' = 'session'): Promise<number> {
  try {
    const { command, options } = parseSessionCommand(args, family);
    if (options.help) {
      process.stdout.write(sessionHelp(command, family) + '\n');
      return 0;
    }
    if (options.query) {
      try {
        (jmespath as typeof jmespath & {
          compile(expression: string): unknown;
        }).compile(String(options.query));
      }
      catch {
        throw new SessionCliError('INVALID_QUERY', 'Invalid JMESPath query.');
      }
    }
    const result = family === 'schedule' ? await executeSchedule(command, options) : await execute(command, options);
    const projected = options.query ? jmespath.search(result, String(options.query)) : result;
    process.stdout.write(render(projected, String(options.output ?? 'json')) + '\n');
    return 0;
  }
  catch (error) {
    const known = error instanceof SessionCliError;
    process.stderr.write(JSON.stringify({ error: { code: known ? error.code : 'CLI_ERROR', message: error instanceof Error ? error.message : String(error) } }) + '\n');
    return known ? error.exitCode : 6;
  }
}

async function scheduleInput(command: string, options: SessionCliOptions) {
  const input: Record<string, unknown> = {};
  for (const key of ['name', 'session-id', 'cron', 'run-at', 'timezone', 'misfire-policy', 'model', 'permission-mode', 'client-token']) {
    if (options[key] !== undefined) input[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = options[key];
  }
  if (['message', 'message-file', 'stdin'].some((key) => options[key] !== undefined)) input.message = await message(options);
  if (options.cron) input.runAt = null;
  if (options['run-at']) input.cron = null;
  if (options['inherit-model']) input.model = null;
  if (options['inherit-permission-mode']) input.permissionMode = null;
  if (command === 'update') input.revision = numberOption(options, 'revision', 0);
  if (command === 'create') input.enabled = !options.paused;
  return input;
}
async function executeSchedule(command: string, options: SessionCliOptions) {
  const request = await createSessionClient(options);
  const resource = '/schedules/' + encodeURIComponent(String(options['schedule-id']));
  const runResource = resource + '/runs/' + encodeURIComponent(String(options['run-id']));
  switch (command) {
    case 'list': return list(request, '/schedules', options);
    case 'show': return request('GET', resource);
    case 'create': return request('POST', '/schedules', await scheduleInput(command, options));
    case 'update': return request('PATCH', resource, await scheduleInput(command, options));
    case 'preview': return request('POST', '/schedules/preview', await scheduleInput(command, options));
    case 'pause':
    case 'resume': return request('POST', resource + '/' + command, {});
    case 'delete': return request('DELETE', resource);
    case 'run': return request('POST', resource + '/run', { clientToken: options['client-token'] });
    case 'run list': return list(request, resource + '/runs', options);
    case 'run show': return request('GET', runResource);
    case 'run cancel': return request('POST', runResource + '/cancel', {});
    default: throw new SessionCliError('INVALID_COMMAND', command);
  }
}
