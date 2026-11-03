import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import type { ModelInfo } from '@opencode/client';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  getOpenCodeDatabasePath,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

import { startOpenCodeServer } from './opencode-server.provider.js';

/** Only native catalog fields used by the model picker; credentials remain in OpenCode. */
type NativeCatalog = {
  models: Pick<ModelInfo, 'id' | 'providerID' | 'name' | 'variants' | 'enabled'>[];
  defaultId?: string;
};

async function readNativeCatalog(directory: string): Promise<NativeCatalog> {
  const signal = AbortSignal.timeout(60_000);
  const { client, server } = await startOpenCodeServer(signal);
  try {
    const location = { directory };
    const catalog = await client.model.list({ location }, { signal });
    const selected = await client.model.default({ location }, { signal });
    return {
      models: catalog.data,
      defaultId: selected.data ? `${selected.data.providerID}/${selected.data.id}` : undefined,
    };
  } finally {
    server.close();
  }
}

function projectNativeCatalog(catalog: NativeCatalog): ProviderModelsDefinition {
  const options = catalog.models.filter((model) => model.enabled).map((model) => ({
    value: `${model.providerID}/${model.id}`,
    label: model.name || model.id,
    description: model.providerID,
    ...(model.variants.length ? { effort: { values: model.variants.map(({ id }) => ({ value: id })) } } : {}),
  }));
  return {
    OPTIONS: options,
    DEFAULT: options.find((model) => model.value === catalog.defaultId)?.value ?? options[0]?.value ?? '',
  };
}

const parseOpenCodeSessionModelValue = (rawModel: unknown): ProviderCurrentActiveModel | null => {
  if (typeof rawModel === 'string') {
    const trimmed = rawModel.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return parseOpenCodeSessionModelValue(JSON.parse(trimmed));
    } catch {
      return { model: trimmed, effort: 'default', source: 'session' };
    }
  }

  const record = readObjectRecord(rawModel);
  if (!record) {
    return null;
  }

  const modelId = readOptionalString(record.id)
    ?? readOptionalString(record.model)
    ?? readOptionalString(record.name)
    ?? readOptionalString(record.value);
  if (!modelId) {
    return null;
  }

  // OpenCode persists the provider and model id in separate fields (for
  // example {"id":"z-ai/glm-5.3-flash","providerID":"openrouter"}), and its
  // CLI's `--model` flag only accepts the composed `<providerID>/<modelID>`
  // form. Compose it here so a resumed session resolves the same model
  // instead of failing with an unknown-model error.
  const providerId = readOptionalString(record.providerID)
    ?? readOptionalString(record.providerId);
  return {
    model: providerId && !modelId.startsWith(`${providerId}/`) ? `${providerId}/${modelId}` : modelId,
    effort: readOptionalString(record.variant) ?? 'default',
    source: 'session',
  };
};

/** Provider registry model adapter for OpenCode native project models and session metadata. */
export class OpenCodeProviderModels implements IProviderModels {
  // Successful catalogs are bounded and isolated by project; failed refreshes propagate.
  private readonly catalogs = new Map<string, { value: ProviderModelsDefinition; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<ProviderModelsDefinition>>();

  constructor(
    private readonly readModels = readNativeCatalog,
    private readonly now: () => number = Date.now,
  ) {}

  async getSupportedModels(workspacePath?: string): Promise<ProviderModelsDefinition> {
    const directory = path.resolve(workspacePath || os.homedir());
    const cached = this.catalogs.get(directory);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const existing = this.pending.get(directory);
    if (existing) return existing;
    const request = this.readModels(directory).then((native) => {
      const value = projectNativeCatalog(native);
      this.catalogs.delete(directory);
      this.catalogs.set(directory, { value, expiresAt: this.now() + 60_000 });
      if (this.catalogs.size > 64) this.catalogs.delete(this.catalogs.keys().next().value!);
      return value;
    }).finally(() => this.pending.delete(directory));
    this.pending.set(directory, request);
    return request;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return { ...buildDefaultProviderCurrentActiveModel(await this.getSupportedModels()), source: 'default' };
    }

    // OpenCode's `session` table is keyed by its own session id, so the stable
    // app id has to be translated first; sessions discovered on disk store the
    // provider id in both columns and resolve to themselves.
    const appSession = sessionsDb.getSessionById(sessionId);
    const providerSessionId = appSession?.provider_session_id ?? sessionId;

    try {
      const dbPath = getOpenCodeDatabasePath();
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });

      try {
        const row = db.prepare(`
          SELECT
            s.id AS sessionId,
            s.model AS model,
            s.agent AS agent,
            s.directory AS directory,
            s.time_updated AS timeUpdated,
            s.time_created AS timeCreated
          FROM session_v2 s
          WHERE s.id = ?
          ORDER BY COALESCE(s.time_updated, s.time_created, 0) DESC
          LIMIT 1
        `).get(providerSessionId) as {
          sessionId?: string;
          model?: unknown;
          agent?: string | null;
          directory?: string | null;
          timeUpdated?: number | null;
          timeCreated?: number | null;
        } | undefined;

        const selection = parseOpenCodeSessionModelValue(row?.model);
        if (selection) return selection;
      } finally {
        db.close();
      }
    } catch {
      // Fall through to the project's native default when session lookup fails.
    }

    return {
      ...buildDefaultProviderCurrentActiveModel(await this.getSupportedModels(appSession?.project_path ?? undefined)),
      source: 'default',
    };
  }
}
