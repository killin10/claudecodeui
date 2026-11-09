import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { AnyRecord, SubscriptionUsage, SubscriptionUsageWindow } from '@/shared/types.js';

/**
 * OpenCode integration ids of the GLM Coding Plan and the quota API host of
 * each. The China plan is sold on bigmodel.cn, the international one on z.ai;
 * keys are not interchangeable.
 */
const ZAI_CODING_PLAN_HOSTS: Record<string, string> = {
  'zhipuai-coding-plan': 'https://open.bigmodel.cn',
  'zai-coding-plan': 'https://api.z.ai',
};

const ZAI_QUOTA_TIMEOUT_MS = 15_000;

/** Units the quota API uses for `unit`, as minutes per unit. */
const ZAI_UNIT_MINUTES: Record<number, number> = {
  1: 1_440, // day
  3: 60, // hour
  5: 43_200, // month (30 days)
  6: 10_080, // week
};

type ZaiCredential = { integrationId: string; apiKey: string };

function readApiKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const key = (value as AnyRecord).key;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

/**
 * Used by this file and the providers tests: finds the GLM Coding Plan API key
 * OpenCode was connected with, in its V2 credential table or, for older
 * installs, its `auth.json`. China first, matching the integrations' order.
 */
export async function readZaiCodingPlanCredential(databasePath: string, authFilePath: string): Promise<ZaiCredential | null> {
  const integrationIds = Object.keys(ZAI_CODING_PLAN_HOSTS);

  if (fs.existsSync(databasePath)) {
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const hasCredentialTable = database.prepare("SELECT name FROM sqlite_master WHERE name = 'credential'").get();
      if (hasCredentialTable) {
        for (const integrationId of integrationIds) {
          const row = database
            .prepare('SELECT value FROM credential WHERE integration_id = ? AND active = 1 ORDER BY time_updated DESC LIMIT 1')
            .get(integrationId) as { value: string } | undefined;
          let apiKey: string | null = null;
          try {
            apiKey = row ? readApiKey(JSON.parse(row.value)) : null;
          } catch {
            apiKey = null;
          }
          if (apiKey) return { integrationId, apiKey };
        }
      }
    } finally {
      database.close();
    }
  }

  try {
    const auth = JSON.parse(await fsp.readFile(authFilePath, 'utf8')) as AnyRecord;
    for (const integrationId of integrationIds) {
      const apiKey = readApiKey(auth?.[integrationId]);
      if (apiKey) return { integrationId, apiKey };
    }
  } catch {
    // No auth.json: OpenCode is on the credential table, or the plan is not connected.
  }

  return null;
}

function toWindow(limit: AnyRecord, index: number): SubscriptionUsageWindow {
  const unitMinutes = ZAI_UNIT_MINUTES[Number(limit.unit)];
  const count = Number(limit.number);
  const windowMinutes = unitMinutes && Number.isFinite(count) && count > 0 ? unitMinutes * count : undefined;
  const period: SubscriptionUsageWindow['period'] = windowMinutes === 300
    ? 'five_hour'
    : windowMinutes === 10_080
      ? 'weekly'
      : windowMinutes === 43_200
        ? 'monthly'
        : 'custom';
  // TIME_LIMIT counts MCP tool calls (web search, web reader, zread), not model tokens.
  const isToolQuota = limit.type === 'TIME_LIMIT';
  const resetsAtMs = Number(limit.nextResetTime);
  const used = Number(limit.currentValue);
  const total = Number(limit.usage);

  return {
    key: `${String(limit.type ?? 'LIMIT').toLowerCase()}_${period}_${index}`,
    period,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    scope: isToolQuota ? 'MCP' : null,
    usedPercent: Number.isFinite(Number(limit.percentage)) ? Number(limit.percentage) : null,
    resetsAt: Number.isFinite(resetsAtMs) && resetsAtMs > 0 ? new Date(resetsAtMs).toISOString() : null,
    ...(isToolQuota && Number.isFinite(used) && Number.isFinite(total) && total > 0 ? { used, limit: total } : {}),
  };
}

/**
 * Used by this file and the providers tests: maps the quota API body to the
 * shared contract, ordered token quotas first (shortest window first), then
 * tool-call quotas.
 */
export function mapZaiQuota(body: AnyRecord, observedAt: string): SubscriptionUsage {
  const limits: AnyRecord[] = Array.isArray(body?.data?.limits) ? body.data.limits : [];
  const windows = limits
    .map(toWindow)
    .sort((left, right) =>
      Number(left.scope !== null) - Number(right.scope !== null)
      || (left.windowMinutes ?? Number.MAX_SAFE_INTEGER) - (right.windowMinutes ?? Number.MAX_SAFE_INTEGER));

  return {
    provider: 'zai',
    status: 'ok',
    plan: typeof body?.data?.level === 'string' ? body.data.level : null,
    windows,
    observedAt,
  };
}

/**
 * Used by the provider subscription-usage service: reads the GLM Coding Plan
 * quota with the API key OpenCode was connected with. Only the quota endpoint
 * is called; the key never leaves this process otherwise.
 */
export async function fetchZaiPlanUsage(
  databasePath: string,
  authFilePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubscriptionUsage> {
  const credential = await readZaiCodingPlanCredential(databasePath, authFilePath);
  if (!credential) {
    return {
      provider: 'zai',
      status: 'unavailable',
      plan: null,
      windows: [],
      observedAt: null,
      message: 'GLM Coding Plan is not connected in OpenCode.',
    };
  }

  const url = `${ZAI_CODING_PLAN_HOSTS[credential.integrationId]}/api/monitor/usage/quota/limit`;
  const response = await fetchImpl(url, {
    headers: { Authorization: credential.apiKey, Accept: 'application/json', 'Accept-Language': 'en-US,en' },
    signal: AbortSignal.timeout(ZAI_QUOTA_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null) as AnyRecord | null;
  if (!response.ok || !body || body.success === false) {
    const reason = typeof body?.msg === 'string' ? body.msg : `HTTP ${response.status}`;
    throw new Error(`GLM Coding Plan quota request failed: ${reason}`);
  }

  return mapZaiQuota(body, new Date().toISOString());
}

/** Used by the provider subscription-usage service for the pre-V2 OpenCode credentials file. */
export function getOpenCodeAuthFilePath(openCodeDatabasePath: string): string {
  return path.join(path.dirname(openCodeDatabasePath), 'auth.json');
}
