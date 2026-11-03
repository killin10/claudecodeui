import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  OpenCodeProviderModels,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';

const OPENCODE_ENV_KEYS = [
  'OPENCODE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
];

/**
 * Runs one case against a throwaway OpenCode home, so the catalog the adapter
 * reports depends on the fixture rather than on the providers the machine
 * running the suite happens to be logged into.
 */
const withOpenCodeHome = async (
  setUp: (homeDir: string) => Promise<void>,
  runTest: (adapter: OpenCodeProviderModels) => Promise<void>,
  readModels = async () => ({ models: [] }),
): Promise<void> => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-'));
  const originalHomedir = os.homedir;
  const originalEnv = OPENCODE_ENV_KEYS.map((key) => [key, process.env[key]] as const);

  (os as any).homedir = () => homeDir;
  for (const key of OPENCODE_ENV_KEYS) {
    delete process.env[key];
  }

  try {
    await setUp(homeDir);
    await runTest(new OpenCodeProviderModels(readModels));
  } finally {
    (os as any).homedir = originalHomedir;
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(homeDir, { recursive: true, force: true });
  }
};

const nativeModel = (id: string, variants: string[] = [], enabled = true) => ({
  id, providerID: 'custom', name: id, enabled, variants: variants.map((id) => ({ id })),
});

test('native models and variants survive without credential or static-catalog filtering', async () => {
  const adapter = new OpenCodeProviderModels(async () => ({
    models: [nativeModel('reasoner', ['low', 'high', 'custom-depth']), nativeModel('disabled', [], false)],
    defaultId: 'custom/reasoner',
  }));
  const catalog = await adapter.getSupportedModels('/project');
  assert.deepEqual(catalog.OPTIONS, [{ value: 'custom/reasoner', label: 'reasoner', description: 'custom',
    effort: { values: [{ value: 'low' }, { value: 'high' }, { value: 'custom-depth' }] } }]);
  assert.equal(catalog.DEFAULT, 'custom/reasoner');
});

test('native catalog controls the default and can legitimately be empty', async () => {
  const adapter = new OpenCodeProviderModels(async () => ({
    models: [nativeModel('first'), nativeModel('preferred')], defaultId: 'custom/preferred',
  }));
  assert.equal((await adapter.getSupportedModels()).DEFAULT, 'custom/preferred');
  const empty = new OpenCodeProviderModels(async () => ({ models: [] }));
  assert.deepEqual(await empty.getSupportedModels(), { OPTIONS: [], DEFAULT: '' });
});

test('catalog cache coalesces concurrent reads and stays isolated by workspace', async () => {
  let now = 0;
  const calls: string[] = [];
  const adapter = new OpenCodeProviderModels(async (directory) => {
    calls.push(directory);
    return { models: [nativeModel(path.basename(directory))] };
  }, () => now);
  const [first, same, other] = await Promise.all([
    adapter.getSupportedModels('/one'), adapter.getSupportedModels('/one'), adapter.getSupportedModels('/two'),
  ]);
  assert.deepEqual(first, same);
  assert.equal(other.DEFAULT, 'custom/two');
  assert.deepEqual(calls, ['/one', '/two']);
  await adapter.getSupportedModels('/one');
  assert.equal(calls.length, 2);
  now = 60_000;
  await adapter.getSupportedModels('/one');
  assert.equal(calls.length, 3);
});

test('failed native discovery is visible and retried rather than replaced by static models', async () => {
  let calls = 0;
  const adapter = new OpenCodeProviderModels(async () => {
    if (++calls === 1) throw new Error('native unavailable');
    return { models: [nativeModel('recovered')] };
  });
  await assert.rejects(adapter.getSupportedModels(), /native unavailable/);
  assert.equal((await adapter.getSupportedModels()).DEFAULT, 'custom/recovered');
});

const writeOpenCodeSessionDatabase = async (homeDir: string, rows: Array<Record<string, unknown>>) => {
  const dbPath = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db');
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE session_v2 (
        id text PRIMARY KEY,
        model text,
        agent text,
        directory text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      );
    `);
    const insert = db.prepare(
      'INSERT INTO session_v2 (id, model, agent, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const [index, row] of rows.entries()) {
      insert.run(
        row.id,
        row.model,
        row.agent ?? null,
        row.directory ?? '/tmp/project',
        row.timeCreated ?? 1700000000000,
        row.timeUpdated ?? 1700000001000 + index,
      );
    }
  } finally {
    db.close();
  }
};

test('OpenCode composes the provider prefix into session model ids', async () => {
  // The lookup translates the app session id through the sessions database,
  // so point it at a throwaway file rather than the developer's real one.
  const tempSessionsDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-model-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempSessionsDirectory, 'auth.db');
    await initializeDatabase();
    // OpenCode stores the provider and model id in separate fields of the
    // session row ({"id":"z-ai/glm-5.3-flash","providerID":"openrouter"}), but
    // the CLI's `--model` flag only resolves the composed
    // `<providerID>/<modelID>` form. Resuming such a session without the prefix
    // fails with an unknown-model server error, which hits OpenRouter users
    // hardest because their model ids carry a slash themselves.
    await withOpenCodeHome(
      (homeDir) => writeOpenCodeSessionDatabase(homeDir, [
        {
          id: 'ses_variant',
          model: JSON.stringify({ id: 'reasoner', providerID: 'custom', variant: 'deep' }),
        },
        {
          id: 'ses_openrouter',
          model: JSON.stringify({
            id: 'z-ai/glm-5.3-flash',
            providerID: 'openrouter',
            variant: 'default',
          }),
        },
        {
          id: 'ses_qualified',
          // An id that already carries the provider prefix must survive as-is.
          model: JSON.stringify({
            id: 'openrouter/z-ai/glm-5.3-flash',
            providerID: 'openrouter',
          }),
        },
        {
          id: 'ses_plain_string',
          model: 'opencode/gpt-5.6-terra',
        },
        {
          id: 'ses_github_copilot',
          model: JSON.stringify({
            id: 'gpt-5.6-terra',
            providerID: 'github-copilot',
          }),
        },
      ]),
      async (adapter) => {
        assert.deepEqual(await adapter.getCurrentActiveModel('ses_variant'), {
          model: 'custom/reasoner', effort: 'deep', source: 'session',
        });
        assert.deepEqual(await adapter.getCurrentActiveModel('ses_github_copilot'), {
          model: 'github-copilot/gpt-5.6-terra', effort: 'default', source: 'session',
        });
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_openrouter')).model,
          'openrouter/z-ai/glm-5.3-flash',
        );
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_qualified')).model,
          'openrouter/z-ai/glm-5.3-flash',
        );
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_plain_string')).model,
          'opencode/gpt-5.6-terra',
        );
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_github_copilot')).model,
          'github-copilot/gpt-5.6-terra',
        );
      },
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempSessionsDirectory, { recursive: true, force: true });
  }
});
