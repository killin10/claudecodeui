import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SessionCliOptions } from '@/shared/types.js';

import { SessionCliError } from './session-command.js';

/** Loads CLI-only config without importing the server or opening its database. */
export async function createSessionClient(options: SessionCliOptions) {
  const file = String(options['config-file'] ?? path.join(os.homedir(), '.config/cloudcli/cli.json'));
  let config: {
    endpoint?: string;
    apiKey?: string;
  } = {};
  try {
    const stat = await fs.stat(file);
    config = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Configuration must be an object.');
    }
    if (config.apiKey && process.platform !== 'win32' && (stat.mode & 0o077)) {
      throw new Error('Credential file must have mode 0600.');
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options['config-file']) {
      throw new SessionCliError('CONFIG_ERROR', error instanceof Error ? error.message : String(error), 6);
    }
  }
  const key = process.env.CLOUDCLI_API_KEY ?? config.apiKey;
  if (typeof key !== 'string' || !key.trim()) {
    throw new SessionCliError('AUTH_REQUIRED', 'Set CLOUDCLI_API_KEY or apiKey in the CLI config file.', 4);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(String(options.endpoint ?? process.env.CLOUDCLI_ENDPOINT ?? config.endpoint ?? 'http://127.0.0.1:3001'));
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) {
      throw new Error();
    }
  }
  catch {
    throw new SessionCliError('CONFIG_ERROR', 'Endpoint must be an HTTP(S) origin without credentials, path, query or fragment.', 6);
  }
  return async (method: string, resource: string, body?: unknown, timeoutMs = 30000): Promise<Record<string, unknown>> => {
    if (options.debug && !options['only-show-errors']) {
      process.stderr.write(`[cloudcli] ${method} ${resource.split('?')[0]}\n`);
    }
    let response: Response;
    try {
      response = await fetch(new URL('/api/session-control/v1' + resource, endpoint), {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new SessionCliError('TRANSPORT_ERROR', 'Request failed or timed out. For mutations the outcome may be unknown; reuse the same client-token when retrying.', 6);
    }
    let result: Record<string, unknown>;
    try {
      result = await response.json() as Record<string, unknown>;
    } catch {
      throw new SessionCliError('INVALID_RESPONSE', `HTTP ${response.status}: expected a JSON response. Check server version and endpoint.`, 6);
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new SessionCliError('INVALID_RESPONSE', 'Expected a JSON object.', 6);
    }
    if (!response.ok) {
      const error = result.error as {
        code?: string;
        message?: string;
      } | undefined;
      const exitCode = [404, 410].includes(response.status) ? 3 : [401, 403].includes(response.status) ? 4 : response.status === 409 ? 5 : response.status < 500 ? 2 : 6;
      throw new SessionCliError(error?.code ?? 'HTTP_ERROR', error?.message ?? `HTTP ${response.status}`, exitCode);
    }
    return result;
  };
}
