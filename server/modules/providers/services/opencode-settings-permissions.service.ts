import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import type { PermissionRule } from '@opencode/client';

import { startOpenCodeServer } from '@/modules/providers/list/opencode/opencode-server.provider.js';
import { clearOpenCodeRememberedApprovals } from '@/modules/providers/list/opencode/opencode-permissions.provider.js';
import { AppError, getOpenCodeConfigDirectory, readObjectRecord } from '@/shared/utils.js';

const invalid = (message: string) => new AppError(message, { code: 'INVALID_OPENCODE_PERMISSIONS', statusCode: 400 });

function readRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value) || value.length > 256) throw invalid('Expected up to 256 permission rules.');
  return value.map((item) => {
    const rule = readObjectRecord(item);
    if (!rule || typeof rule.action !== 'string' || !rule.action.trim() || rule.action.length > 4096
      || typeof rule.resource !== 'string' || !rule.resource.trim() || rule.resource.length > 4096
      || !['allow', 'deny', 'ask'].includes(rule.effect)) {
      throw invalid('Each rule needs an action, resource and allow/deny/ask effect.');
    }
    return { action: rule.action, resource: rule.resource, effect: rule.effect };
  });
}

async function editableFile() {
  const directory = getOpenCodeConfigDirectory();
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const filename = path.join(directory, name);
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw invalid('Permission settings require a regular config file smaller than 2 MB.');
      return { path: filename, text: await readFile(filename, 'utf8'), mode: info.mode };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { path: path.join(directory, 'opencode.json'), text: '', mode: 0o600 };
}

async function readEditable() {
  const file = await editableFile();
  const errors: ParseError[] = [];
  const config = readObjectRecord(parse(file.text.trim() ? file.text : '{}', errors, { allowTrailingComma: true }));
  if (errors.length || !config) throw invalid('Fix the invalid OpenCode JSON/JSONC config before editing permissions.');
  if ('permission' in config) throw invalid('Migrate the legacy permission field to V2 permissions before editing it here.');
  const rules = readRules(config.permissions ?? []);
  const revision = createHash('sha256').update(file.path).update('\0').update(file.text).digest('hex');
  return { ...file, rules, revision };
}

async function readSources(directory: string, startServer: typeof startOpenCodeServer) {
  const signal = AbortSignal.timeout(60_000);
  const { client, server } = await startServer(signal);
  try {
    const entries = await client.config.get({ location: { directory } }, { signal });
    // Return only permission fields: native config can also contain API keys,
    // MCP environment variables and other secrets unrelated to this panel.
    const sources = entries.flatMap((entry) => {
      if (entry.type !== 'document') return [];
      const rules = entry.info.permissions ?? [];
      const agents = Object.entries(entry.info.agents ?? {}).flatMap(([name, agent]) =>
        agent.permissions?.length ? [{ name, rules: agent.permissions }] : []);
      return rules.length || agents.length ? [{ path: entry.path ?? null, rules, agents }] : [];
    });
    const location = await client.location.get({ location: { directory } }, { signal });
    const saved = await client.permission.saved.list({ projectID: location.project.id }, { signal });
    return { sources, saved: saved.map(({ id, action, resource }) => ({ id, action, resource })) };
  } finally {
    server.close();
  }
}

async function saveRules(input: unknown) {
  const body = readObjectRecord(input);
  const rules = readRules(body?.rules);
  const file = await readEditable();
  if (body?.revision !== file.revision) {
    throw new AppError('OpenCode config changed. Reload before saving again.', { code: 'OPENCODE_CONFIG_CONFLICT', statusCode: 409 });
  }
  const original = file.text.trim() ? file.text : '{}\n';
  const updated = applyEdits(original, modify(original, ['permissions'], rules, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  }));
  await mkdir(path.dirname(file.path), { recursive: true });
  const temporary = `${file.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updated, { mode: file.mode, flag: 'wx' });
    if ((await readEditable()).revision !== file.revision) {
      throw new AppError('OpenCode config changed. Reload before saving again.', { code: 'OPENCODE_CONFIG_CONFLICT', statusCode: 409 });
    }
    await rename(temporary, file.path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path: file.path, rules, revision: createHash('sha256').update(file.path).update('\0').update(updated).digest('hex') };
}

function readSavedChange(input: unknown) {
  const body = readObjectRecord(input);
  if (!body || typeof body.id !== 'string' || !body.id || body.id.length > 256
    || (body.operation !== 'update' && body.operation !== 'remove')
    || (body.workspacePath !== undefined && typeof body.workspacePath !== 'string')) {
    throw invalid('Expected a saved approval id, operation and optional directory.');
  }
  const expected = readRules([{ ...readObjectRecord(body.expected), effect: 'allow' }])[0];
  const rule = body.operation === 'update' ? readRules([{ ...readObjectRecord(body.rule), effect: 'allow' }])[0] : null;
  const directory = body.workspacePath ? path.resolve(body.workspacePath) : os.homedir();
  return { id: body.id, expected, rule, directory };
}

async function changeSaved(input: unknown, startServer: typeof startOpenCodeServer) {
  const { id, expected, rule, directory } = readSavedChange(input);
  const signal = AbortSignal.timeout(60_000);
  const { client, server } = await startServer(signal);
  try {
    const location = await client.location.get({ location: { directory } }, { signal });
    const projectID = location.project.id;
    const saved = await client.permission.saved.list({ projectID }, { signal });
    const current = saved.find((entry) => entry.id === id);
    if (!current) throw new AppError('Saved approval not found in this project.', { code: 'OPENCODE_APPROVAL_NOT_FOUND', statusCode: 404 });
    if (current.action !== expected.action || current.resource !== expected.resource) {
      throw new AppError('Saved approval changed. Reload before editing it.', { code: 'OPENCODE_CONFIG_CONFLICT', statusCode: 409 });
    }
    if (rule) await client.permission.saved.update({ id: current.id, action: rule.action, resource: rule.resource }, { signal });
    else await client.permission.saved.remove({ id: current.id }, { signal });
    clearOpenCodeRememberedApprovals(projectID);
    return { id: current.id };
  } finally {
    server.close();
  }
}

/** Provider routes use the production instance; tests inject the native host to verify source filtering and cleanup. */
export function createOpenCodeSettingsPermissionsService(startServer = startOpenCodeServer) {
  // Serializes UI saves; revisions also reject external edits since the panel loaded.
  let saving: Promise<unknown> = Promise.resolve();
  return {
    async read(workspacePath?: string) {
      const directory = workspacePath ? path.resolve(workspacePath) : os.homedir();
      const file = await readEditable();
      return { directory, editable: { path: file.path, revision: file.revision, rules: file.rules }, ...await readSources(directory, startServer) };
    },
    save(input: unknown) {
      const result = saving.then(() => saveRules(input));
      saving = result.catch(() => undefined);
      return result;
    },
    changeSaved(input: unknown) {
      const result = saving.then(() => changeSaved(input, startServer));
      saving = result.catch(() => undefined);
      return result;
    },
  };
}

/** Shared provider-route service for native permission settings. */
export const opencodeSettingsPermissionsService = createOpenCodeSettingsPermissionsService();
